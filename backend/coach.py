"""
CueIQ coach: Gemini picks which shot to play and explains how to play it.

The geometry is NOT the model's job (LLMs are bad at angles). The frontend's shot finder
computes every legal, unobstructed shot with exact cut angles; Gemini picks one of those
candidates and coaches it: aim, speed, spin, where the cue ball ends up.

Its memory of the player is real numbers, not vibes: every shot they've ever taken is in
Tiger Data (store.player_stats), so the prompt says things like "makes 82% of cuts under
15 degrees, 31% over 45". Gemini uses that to steer them toward shots they actually make.
"""
import json
import logging
import math
import os
import re

import physics
import store
from game import ball_type, remaining

log = logging.getLogger("cueiq.coach")

SYSTEM_PROMPT = """You are CueIQ, a pool coach standing next to the player. Talk like a friend
giving a quick tip at the table: short, concrete, "you".
Pick the candidate shot that pockets a ball AND leaves the easiest next shot. Use the
player's stats: steer them away from shots they keep missing. Only use the candidates
listed; never invent a shot. If none is reasonable, use shot_index -1 and describe a
simple safety in aim.
Each candidate comes with its aim, a plan (speed, spin, where the cue ball stops, the
next shot) and, with ball in hand, where to put the cue ball. Use those exactly: don't
invent a different speed, spin, aim or spot.
Every field is ONE short sentence of at most 15 words. Never give coordinates or
distances in units, never mention candidate numbers, never repeat the speed and spin
(the app shows them)."""

ADVICE_SCHEMA = {
    "type": "object",
    "properties": {
        "shot_index": {"type": "integer", "description": "candidate number, or -1 for a safety"},
        "aim": {"type": "string", "description": "one sentence, max 15 words: where to aim (and, "
                "with ball in hand, where to put the cue ball), from the candidate's aim"},
        "speed": {"type": "string", "enum": ["soft", "medium", "firm", "hard"]},
        "spin": {"type": "string", "enum": ["center", "follow", "draw", "stop",
                                            "left english", "right english"]},
        "cue_ball_after": {"type": "string", "description": "one sentence, max 15 words: where "
                           "the cue ball ends up and the next shot it leaves"},
        "why": {"type": "string", "description": "one sentence, max 15 words: why this shot"},
        "tip": {"type": "string", "description": "one sentence, max 12 words, personal to this "
                "player's stats; empty string if there's nothing specific to say"},
    },
    "required": ["shot_index", "aim", "speed", "spin", "cue_ball_after", "why", "tip"],
}


class CoachError(Exception):
    """The coach couldn't answer. Message is shown to the user."""


def model_name() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")


def models_to_try() -> list[str]:
    """GEMINI_MODEL first, then the fallbacks: Gemini models get overloaded (503 "high
    demand") or slow at peak times, and a player waiting at the table needs an answer."""
    fallbacks = os.getenv("GEMINI_FALLBACK_MODELS", "gemini-3.8-flash,gemini-3.5-flash")
    return list(dict.fromkeys([model_name(), *(m.strip() for m in fallbacks.split(",") if m.strip())]))


MODEL_TIMEOUT_S = 25   # per model; then try the next one


def gemini_key() -> str | None:
    k = os.getenv("GEMINI_API_KEY", "")
    return None if not k or "your-key" in k else k


_client = None


def gemini_client():
    """One shared client. (A throwaway genai.Client closes its connection when it's
    garbage-collected, which can happen mid-call in `genai.Client(...).models.x()`.)"""
    global _client
    key = gemini_key()
    if key is None:
        raise CoachError("Gemini isn't set up: put GEMINI_API_KEY in backend/.env.")
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=key)
    return _client


# ----------------------------------------------------------------- prompt
def _describe_stats(stats: dict | None) -> list[str]:
    if not stats or not stats["attempts"]:
        return ["No shooting history yet for this player: coach them as a beginner-to-average player."]

    def fmt(rates: dict) -> str:
        return ", ".join(f"{k}: {v['rate']:.0%} of {v['attempts']}" for k, v in rates.items())

    lines = [f"Their history ({stats['games']} games, {stats['attempts']} called shots): "
             f"makes {stats['make_rate']:.0%} overall, scratches on {stats['scratch_rate']:.0%} of shots."]
    if stats["by_cut_angle"]:
        lines.append(f"  Make rate by cut angle (degrees): {fmt(stats['by_cut_angle'])}.")
    if stats["by_kind"]:
        lines.append(f"  By shot type: {fmt(stats['by_kind'])}.")
    if stats["by_pocket"]:
        lines.append(f"  By pocket: {fmt(stats['by_pocket'])}.")
    if len(stats["weekly"]) > 1:
        trend = ", ".join(f"{w['week']}: {w['rate']:.0%}" for w in reversed(stats["weekly"]))
        lines.append(f"  Weekly make rate, oldest first: {trend}.")
    return lines


POCKET_WORDS = {"top_left": "top left", "top_side": "top side", "top_right": "top right",
                "bottom_left": "bottom left", "bottom_side": "bottom side", "bottom_right": "bottom right"}


def _where(x: float, y: float) -> str:
    """A spot on the table in words ("near the top right pocket", "on the bottom rail,
    left of the side pocket", "in the middle of the table")."""
    pk = min(physics.pockets(), key=lambda p: math.hypot(x - p.x, y - p.y))
    if math.hypot(x - pk.x, y - pk.y) < 90:
        return f"near the {POCKET_WORDS[pk.name]} pocket"
    rails = {"top rail": y, "bottom rail": physics.TABLE_H - y,
             "left end rail": x, "right end rail": physics.TABLE_W - x}
    rail, gap = min(rails.items(), key=lambda kv: kv[1])
    if gap < 35:
        if rail in ("top rail", "bottom rail"):
            part = "left of the side pocket" if x < physics.TABLE_W / 2 else "right of the side pocket"
            return f"on the {rail}, {part}"
        return f"on the {rail}"
    col = "left side" if x < physics.TABLE_W / 3 else "right side" if x > 2 * physics.TABLE_W / 3 else "middle"
    row = "top" if y < physics.TABLE_H / 3 else "bottom" if y > 2 * physics.TABLE_H / 3 else ""
    if col == "middle":
        return f"in the {row + ' ' if row else ''}middle of the table"
    return f"on the {row + ' ' if row else ''}{col} of the table"


def _aim(cue: tuple, shot: "physics.Shot", balls: list[dict]) -> str:
    """How to hit the object ball: fullness from the cut angle, side from the geometry."""
    n = shot.target_id
    cut = shot.cut
    if cut < 4:
        return f"straight into the {n}, full ball"
    full = ("three-quarter" if cut < 22 else "half" if cut < 38 else "quarter" if cut < 55 else "thin")
    t = balls[shot.target_index]
    d = (shot.ghost[0] - cue[0], shot.ghost[1] - cue[1])
    v = (t["x"] - cue[0], t["y"] - cue[1])
    side = "left" if d[0] * v[1] - d[1] * v[0] > 0 else "right"   # y points down
    return f"{full} ball on the {side} side of the {n}"


def _placement(cue: tuple, shot: "physics.Shot", balls: list[dict]) -> str:
    """Where to put the cue ball, with ball in hand, in words."""
    t = balls[shot.target_index]
    widths = max(1, round(math.hypot(cue[0] - t["x"], cue[1] - t["y"]) / (2 * physics.R)) - 1)
    back = f"about {widths} ball-width{'s' if widths > 1 else ''} back"
    pocket = POCKET_WORDS[shot.pocket.name]
    if shot.cut < 4:
        return f"straight behind the {shot.target_id}, in line with the {pocket} pocket, {back}"
    return f"behind the {shot.target_id}, slightly off the line to the {pocket} pocket, {back}"


def _describe_plan(plan: dict | None) -> str:
    if plan is None:
        return " Physics: no power or spin pockets it reliably."
    nxt = plan["next_shot"]
    after = (f"leaves the {nxt['target_ball']} into the {POCKET_WORDS[nxt['pocket']]} pocket"
             if nxt else "leaves no easy next shot")
    stop = plan["cue_stop"]
    return (f" Plan: {physics.speed_word(plan['power'])}, "
            f"{physics.spin_word((plan['spin']['x'], plan['spin']['y']))}; the cue ball stops "
            f"{_where(stop['x'], stop['y'])}{' (SCRATCH RISK)' if plan['scratch'] else ''} and {after}.")


def _describe(state: dict, candidates: list[dict], stats: dict | None,
              plans: dict[int, dict], spots: dict[int, dict] | None = None) -> str:
    me = state["players"][state["turn"]]
    opp = state["players"][1 - state["turn"]]
    group = me["group"]
    mine = remaining(state, group) if group else []
    lines = [
        f"Player up: {me['name']}. Group: {group + 's' if group else 'table is open'}.",
        f"Their balls left: {mine or ('8-ball only' if group else 'any')}.",
        f"Opponent {opp['name']}: {opp['group'] + 's' if opp['group'] else 'no group yet'}, "
        f"{len(remaining(state, opp['group'])) if opp['group'] else '?'} balls left.",
        *_describe_stats(stats),
        "Balls on the table:",
    ]
    for b, v in state["balls"].items():
        if b == "cue" and spots:
            continue
        if v["status"] == "on" and v["x"] is not None:
            label = "cue ball" if b == "cue" else f"{b} ({ball_type(b)})"
            lines.append(f"  {label}: {_where(v['x'], v['y'])}")
    recent = state["history"][-6:]
    if recent:
        lines.append("Recent shots this game:")
        for e in recent:
            made = e["pocketed"] or "nothing"
            meant = e.get("intended")
            called = f", went for the {meant['target']} ({'made' if e['made'] else 'missed'})" if meant else ""
            lines.append(f"  {e['player']}: pocketed {made}{', scratched' if e['scratch'] else ''}"
                         f"{called} -> {e['result']}")
    if spots:
        lines.append("BALL IN HAND: the opponent scratched, so the player puts the cue ball anywhere. "
                     "Each candidate says where to put it; say that in aim (the app marks the spot too).")
    lines.append("Candidate shots (difficulty 0 = easy, 1+ = hard):")
    group = me["group"]
    balls = physics.balls_from_state(state)
    cue_ball = next(((b["x"], b["y"]) for b in balls if b["type"] == "cue"), None)
    for c in candidates:
        cue = (spots[c["index"]]["x"], spots[c["index"]]["y"]) if spots and c["index"] in spots else cue_ball
        layout = balls if not spots else [*balls, {"id": None, "type": "cue", "x": cue[0], "y": cue[1]}]
        shot = cue and physics.match_shot(layout, group, c["target_id"], c["pocket"], c["kind"], c["cut_angle"])
        how = ""
        if shot:
            how = f" Aim: {_aim(cue, shot, layout)}."
            if spots:
                how = f" Put the cue ball {_placement(cue, shot, layout)}." + how
        reach = "short" if c["cue_distance"] < 250 else "long" if c["cue_distance"] > 550 else "medium"
        lines.append(
            f"  #{c['index']}: the {c['target_id']} into the {POCKET_WORDS.get(c['pocket'], c['pocket'])} "
            f"pocket, {c['kind']}, {c['cut_angle']:.0f} degree cut, {reach} cue ball travel, "
            f"difficulty {c['difficulty']}.{how}" + _describe_plan(plans.get(c["index"]))
        )
    if not candidates:
        lines.append("  (none: no clear shot at a legal ball)")
    return "\n".join(lines)


_COORDS = re.compile(r"(\s+(at|near|to|around|by))?\s*\(?\b\d{2,4}(\.\d+)?\s*,\s*\d{2,4}(\.\d+)?\b\)?")
_SHOT_REF = re.compile(r"\b(shot|candidate|option)\s*#?\s*(\d+|zero|one|two|three)\b", re.I)
MAX_WORDS = 22


def _tidy(text: str) -> str:
    """Keep the model honest about length and never let coordinates through: drop any
    "(798, 279)", references to candidate numbers, and anything past the first sentence."""
    text = _COORDS.sub("", text or "")
    text = _SHOT_REF.sub("this shot", text)
    text = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
    words = text.split()
    if len(words) > MAX_WORDS:
        text = " ".join(words[:MAX_WORDS]).rstrip(",;:") + "."
    return text.strip()


def _validate(advice: dict, candidates: list[dict]) -> dict:
    by_index = {c["index"]: c for c in candidates}
    chosen = by_index.get(advice.get("shot_index", -1))
    # Geometry comes from the shot finder, never from the model.
    advice["shot_index"] = chosen["index"] if chosen else -1
    advice["target_ball"] = chosen["target_id"] if chosen else None
    advice["pocket"] = chosen["pocket"] if chosen else None
    for k in ("aim", "speed", "spin", "cue_ball_after", "why", "tip"):
        advice.setdefault(k, "")
    for k in ("aim", "cue_ball_after", "why", "tip"):
        advice[k] = _tidy(advice[k])
    return advice


def _ask_gemini(prompt: str) -> str:
    from google.genai import types

    errors = []
    for model in models_to_try():
        try:
            resp = gemini_client().models.generate_content(
                model=model, contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_json_schema=ADVICE_SCHEMA,
                    http_options=types.HttpOptions(timeout=MODEL_TIMEOUT_S * 1000),
                ),
            )
            return resp.text or ""
        except Exception as e:   # overloaded, timed out, unknown model: next one
            log.warning("gemini %s failed: %s", model, str(e)[:200])
            errors.append(f"{model}: {type(e).__name__}")
    raise CoachError("The coach is busy right now (Gemini is overloaded). Try again in a moment. "
                     f"[{'; '.join(errors)}]")


# ------------------------------------------------------------------ advice
def _plans(state: dict, candidates: list[dict]) -> dict[int, dict]:
    """Physics plan (power, spin, cue ball path...) for each candidate that one pockets.
    Empty if the cue ball's position isn't known. Physics only helps the coach: if it
    fails, advice still works without it."""
    try:
        group = state["players"][state["turn"]]["group"]
        balls = physics.balls_from_state(state)
        if not any(b["type"] == "cue" for b in balls):
            return {}
        out = {}
        for c in candidates:
            shot = physics.match_shot(balls, group, c["target_id"], c["pocket"], c["kind"], c["cut_angle"])
            p = shot and physics.plan(balls, shot, group)
            if p:
                out[c["index"]] = physics.plan_json(p)
        return out
    except Exception as e:
        log.warning("physics planning failed: %s", e)
        return {}


def _physics_for(state: dict, chosen: dict, advice: dict, plans: dict[int, dict]) -> dict | None:
    """Numbers for the spin indicator and power bar: the chosen shot's plan, or, without
    one, a simulation of the coach's words (`planned: false`)."""
    if chosen["index"] in plans:
        return plans[chosen["index"]]
    try:
        group = state["players"][state["turn"]]["group"]
        balls = physics.balls_from_state(state)
        shot = physics.match_shot(balls, group, chosen["target_id"], chosen["pocket"], chosen["kind"],
                                  chosen["cut_angle"])
        if shot is None:
            return None
        power = physics.WORD_POWER.get(advice["speed"], 0.3)
        spin = physics.WORD_SPIN.get(advice["spin"], (0.0, 0.0))
        return physics.result_json(physics.simulate(balls, shot, power, spin))
    except Exception as e:
        log.warning("physics simulation failed: %s", e)
        return None


def _hand_candidates(state: dict) -> tuple[list[dict], dict[int, dict], dict[int, dict]]:
    """Ball in hand: the frontend's candidates were found from the cue ball's old spot, so
    the backend makes its own: the best cue ball spots, each with its shot and plan.
    Returns (candidates, plans by index, cue spot by index)."""
    group = state["players"][state["turn"]]["group"]
    balls = physics.balls_from_state(state)         # leaves the cue ball out when in hand
    candidates, plans, spots = [], {}, {}
    for i, h in enumerate(physics.ball_in_hand_options(balls, group, 3)):
        target = balls[h.shot.target_index]
        candidates.append({
            "index": i, "target_id": h.shot.target_id, "pocket": h.shot.pocket.name,
            "kind": h.shot.kind, "cut_angle": round(h.shot.cut, 1),
            "difficulty": round(h.shot.difficulty, 2),
            "cue_distance": round(math.dist(h.cue, h.shot.ghost)),
            "target_distance": round(math.dist((target["x"], target["y"]), h.shot.pocket.mouth)),
        })
        plans[i] = physics.plan_json(h.plan)
        spots[i] = {"x": round(h.cue[0], 1), "y": round(h.cue[1], 1)}
    return candidates, plans, spots


def advise(state: dict, candidates: list[dict]) -> dict:
    """Pick and explain a shot for the player whose turn it is. Sets state['last_advice'];
    the caller saves the game. With ball in hand, `candidates` is ignored: the backend
    picks cue ball spots itself, and the advice says where to put it (`ball_in_hand`)."""
    name = state["players"][state["turn"]]["name"]
    spots: dict[int, dict] = {}
    if state.get("ball_in_hand"):
        candidates, plans, spots = _hand_candidates(state)
    try:
        stats = store.player_stats(name)
    except store.StoreError as e:   # stats make advice better; they're not required for it
        log.warning("no stats for %s: %s", name, e)
        stats = None
    if not state.get("ball_in_hand"):
        plans = _plans(state, candidates)
    try:
        advice = _validate(json.loads(_ask_gemini(_describe(state, candidates, stats, plans, spots))),
                           candidates)
    except CoachError:
        raise
    except json.JSONDecodeError as e:
        raise CoachError("The coach gave an answer we couldn't read. Try again.") from e
    except Exception as e:   # SDK errors: bad key, quota, unknown model, network
        log.warning("gemini failed: %s", e)
        raise CoachError(f"The coach is unavailable right now ({type(e).__name__}: {e}).") from e

    if not stats or not stats.get("attempts"):
        advice["tip"] = ""     # a "personal" tip with no history to go on is just filler
    chosen = next((c for c in candidates if c["index"] == advice["shot_index"]), None)
    if spots:
        plan = plans.get(chosen["index"]) if chosen else None
    else:
        plan = _physics_for(state, chosen, advice, plans) if chosen else None
    # Where to put the cue ball, with ball in hand (None otherwise).
    advice["ball_in_hand"] = {"cue": spots[chosen["index"]]} if spots and chosen else None
    if plan and plan["planned"]:
        # The words always match the numbers the indicator shows.
        advice["speed"] = physics.speed_word(plan["power"])
        advice["spin"] = physics.spin_word((plan["spin"]["x"], plan["spin"]["y"]))
    advice["physics"] = plan
    state["last_advice"] = {
        **{k: v for k, v in advice.items() if k != "physics"},   # paths aren't worth storing
        "cut_angle": chosen and chosen["cut_angle"], "kind": chosen and chosen["kind"],
        "power": plan and plan["power"], "spin_xy": plan and plan["spin"],
    }
    return advice


def speech(advice: dict) -> str:
    """The advice as something to say out loud: what, how, and where the cue ball goes.
    Short on purpose (the why and the tip stay on screen)."""
    if advice.get("target_ball") is None:
        opening = "No good shot here. Play safe."
    else:
        opening = f"The {advice['target_ball']} in the {POCKET_WORDS[advice['pocket']]} pocket."
    spin = "" if advice["spin"] == "center" else f", with {advice['spin']}"
    return " ".join(x for x in (
        opening, advice["aim"], f"{advice['speed'].capitalize()} speed{spin}.", advice["cue_ball_after"],
    ) if x)

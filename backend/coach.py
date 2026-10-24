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
import os

import store
from game import ball_type, remaining

log = logging.getLogger("cueiq.coach")

SYSTEM_PROMPT = """You are CueIQ, a friendly, expert 8-ball pool coach.
You get the table state, the player's real shooting stats, and a numbered list of
candidate shots. The candidates' geometry (cut angle, distances, path is clear) is
computed exactly: trust it, never invent shots.
Pick the shot that gives the best chance to pocket a ball AND leave the cue ball in good
position for the next one. Use the stats: steer them away from the shot types they
keep missing and toward the ones they make, and mention it when it matters. If no
candidate is reasonable, use shot_index -1 and describe a safety instead.
Explain like you're standing next to them: concrete, short, no jargon without a hint.
Your aim, cue_ball_after and tip are read aloud, so write them as spoken sentences."""

ADVICE_SCHEMA = {
    "type": "object",
    "properties": {
        "shot_index": {"type": "integer", "description": "candidate number, or -1 for a safety"},
        "aim": {"type": "string", "description": "where to aim, in plain words"},
        "speed": {"type": "string", "enum": ["soft", "medium", "firm", "hard"]},
        "spin": {"type": "string", "enum": ["center", "follow", "draw", "stop",
                                            "left english", "right english"]},
        "cue_ball_after": {"type": "string", "description": "where the cue ball should end up, and why"},
        "why": {"type": "string", "description": "why this shot over the others"},
        "tip": {"type": "string", "description": "one tip personal to this player"},
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


def _describe(state: dict, candidates: list[dict], stats: dict | None) -> str:
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
        "Table is 1000 x 500 units (x right, y down), pockets at the 4 corners and the middle "
        "of the top and bottom rails. Balls on the table (last seen position):",
    ]
    for b, v in state["balls"].items():
        if v["status"] == "on" and v["x"] is not None:
            label = "cue ball" if b == "cue" else f"{b} ({ball_type(b)})"
            lines.append(f"  {label} at ({v['x']:.0f}, {v['y']:.0f})")
    recent = state["history"][-6:]
    if recent:
        lines.append("Recent shots this game:")
        for e in recent:
            made = e["pocketed"] or "nothing"
            meant = e.get("intended")
            called = f", went for the {meant['target']} ({'made' if e['made'] else 'missed'})" if meant else ""
            lines.append(f"  {e['player']}: pocketed {made}{', scratched' if e['scratch'] else ''}"
                         f"{called} -> {e['result']}")
    lines.append("Candidate shots (difficulty 0 = easy, 1+ = hard):")
    for c in candidates:
        lines.append(
            f"  #{c['index']}: the {c['target_id']} into {c['pocket'].replace('_', ' ')}, "
            f"{c['kind']}, cut {c['cut_angle']:.0f} deg, cue ball travels {c['cue_distance']:.0f}, "
            f"object ball travels {c['target_distance']:.0f}, difficulty {c['difficulty']}"
        )
    if not candidates:
        lines.append("  (none: no clear shot at a legal ball)")
    return "\n".join(lines)


def _validate(advice: dict, candidates: list[dict]) -> dict:
    by_index = {c["index"]: c for c in candidates}
    chosen = by_index.get(advice.get("shot_index", -1))
    # Geometry comes from the shot finder, never from the model.
    advice["shot_index"] = chosen["index"] if chosen else -1
    advice["target_ball"] = chosen["target_id"] if chosen else None
    advice["pocket"] = chosen["pocket"] if chosen else None
    for k in ("aim", "speed", "spin", "cue_ball_after", "why", "tip"):
        advice.setdefault(k, "")
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
def advise(state: dict, candidates: list[dict]) -> dict:
    """Pick and explain a shot for the player whose turn it is. Sets state['last_advice'];
    the caller saves the game."""
    name = state["players"][state["turn"]]["name"]
    try:
        stats = store.player_stats(name)
    except store.StoreError as e:   # stats make advice better; they're not required for it
        log.warning("no stats for %s: %s", name, e)
        stats = None
    try:
        advice = _validate(json.loads(_ask_gemini(_describe(state, candidates, stats))), candidates)
    except CoachError:
        raise
    except json.JSONDecodeError as e:
        raise CoachError("The coach gave an answer we couldn't read. Try again.") from e
    except Exception as e:   # SDK errors: bad key, quota, unknown model, network
        log.warning("gemini failed: %s", e)
        raise CoachError(f"The coach is unavailable right now ({type(e).__name__}: {e}).") from e

    chosen = next((c for c in candidates if c["index"] == advice["shot_index"]), None)
    state["last_advice"] = {**advice, "cut_angle": chosen and chosen["cut_angle"],
                            "kind": chosen and chosen["kind"]}
    return advice


def speech(advice: dict) -> str:
    """The advice as something to say out loud."""
    if advice.get("target_ball") is None:
        opening = "No good shot here. Play safe."
    else:
        opening = f"Go for the {advice['target_ball']} in the {advice['pocket'].replace('_', ' ')} pocket."
    spin = "" if advice["spin"] == "center" else f" with {advice['spin']}"
    return " ".join(s for s in (
        opening, advice["aim"], f"Hit it {advice['speed']}{spin}.",
        advice["cue_ball_after"], advice["tip"],
    ) if s)

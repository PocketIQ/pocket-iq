"""
CueIQ game memory: which balls are still on the table, whose turn it is, 8-ball rules.

Pure functions on a plain dict (stored as JSONB in Tiger Data), so they're easy to test.
The table state here is AUTHORITATIVE. Vision only proposes; this decides:
- Every detection is matched to a ball that's still on the table, using its color type,
  its read number, and where that ball was last seen. A pocketed ball can't come back,
  so a detection that looks like one gets matched to a ball still in play, or rejected.
- Detections left over after matching are rejected as false detections (glare, chalk,
  a hand...). There can't be more balls than the table has left.
- A ball seen in an earlier photo but not in this one is NOT removed (it may be hidden
  behind another ball). It's reported as "missing" and the player confirms if it went in.
  Balls never seen yet aren't "missing": they were never found in the first place.
"""
import math
import time
import uuid

SOLIDS = tuple(range(1, 8))
STRIPES = tuple(range(9, 16))

# Matching costs. A detection is matched to the cheapest ball still on the table;
# anything costing more than MATCH_MAX_COST is treated as a false detection.
MATCH_MAX_COST = 1.6
MOVE_SCALE = 300          # table units; a ball this far from its last spot costs +0.5
FLAG_COST = 0.6           # matches costlier than this get flagged for the user to confirm
UNSEEN_COST = 0.25        # position cost for a ball we have never seen yet


class GameError(Exception):
    """A request that breaks the rules or the game state. Message is shown to the user."""


def ball_type(bid: str | int) -> str:
    if bid == "cue":
        return "cue"
    n = int(bid)
    return "eight" if n == 8 else "solid" if n < 8 else "stripe"


def group_ids(group: str) -> tuple[int, ...]:
    return SOLIDS if group == "solid" else STRIPES


def new_game(players: list[str]) -> dict:
    return {
        "_id": uuid.uuid4().hex[:12],
        "created": time.time(),
        "players": [{"name": n, "group": None} for n in players],
        "turn": 0,                   # index into players
        "winner": None,              # index into players, once someone wins
        "balls": {b: {"status": "on", "x": None, "y": None}
                  for b in ["cue", *map(str, range(1, 16))]},
        "history": [],               # one event per shot, newest last
        "last_advice": None,         # the coach's suggestion for the shot being played
    }


def on_table(state: dict) -> list[str]:
    return [b for b, v in state["balls"].items() if v["status"] == "on"]


def remaining(state: dict, group: str | None) -> list[int]:
    """Object balls of this group still on the table (both groups if None)."""
    ids = group_ids(group) if group else (*SOLIDS, *STRIPES)
    return [i for i in ids if state["balls"][str(i)]["status"] == "on"]


# ------------------------------------------------------------- detections
def _cost(det: dict, bid: str, ball: dict) -> float:
    want = ball_type(bid)
    got = det["type"]
    if got == want:
        cost = 0.0
    elif {got, want} == {"solid", "stripe"}:
        cost = 0.7      # a stripe with its band turned down reads as mostly one color
    elif {got, want} <= {"cue", "stripe"}:
        cost = 0.9      # a stripe with its band hidden looks like the cue ball
    else:
        cost = 1.3
    if det.get("id") is not None and want != "cue":
        # The number vision read from the color: a match is strong evidence, a mismatch
        # is weak evidence against (hue reading is a best guess).
        cost += -0.4 if det["id"] == int(bid) else 0.3 * det["confidence"]
    if ball["x"] is not None:
        moved = math.hypot(det["x"] - ball["x"], det["y"] - ball["y"])
        cost += 0.5 * min(1.0, moved / MOVE_SCALE)
    else:
        # Never seen: it could be anywhere, so it costs as much as a ball that moved
        # halfway across the scale. A ball last seen right here should win over it.
        cost += UNSEEN_COST
    return cost


def reconcile(state: dict, detections: list[dict]) -> dict:
    """
    Match this photo's detections to the balls still in play, update where each ball
    was last seen, and return
      balls:    the matched detections, with the remembered ball's id and type
      missing:  ids still in play, seen in an earlier photo but not in this one
                ("cue" too, which suggests a scratch)
      rejected: detections that didn't match any ball still in play
    """
    live = on_table(state)
    pairs = sorted(
        (_cost(d, b, state["balls"][b]), di, b)
        for di, d in enumerate(detections) for b in live
    )
    # Greedy: cheapest pair first. With <= 16 balls this is close to optimal and simple.
    used_det, used_ball, matches = set(), set(), []
    for cost, di, b in pairs:
        if cost > MATCH_MAX_COST:
            break
        if di in used_det or b in used_ball:
            continue
        used_det.add(di)
        used_ball.add(b)
        matches.append((di, b, cost))

    balls = []
    for di, b, cost in matches:
        d = detections[di]
        state["balls"][b].update(x=d["x"], y=d["y"])
        conf = d["confidence"] if cost <= FLAG_COST else min(d["confidence"], 0.5)
        balls.append({
            "id": None if b == "cue" else int(b), "type": ball_type(b),
            "x": d["x"], "y": d["y"], "confidence": round(float(conf), 2),
        })
    return {
        "balls": balls,
        # Unmatched balls keep their last position, so x is set only if seen before.
        "missing": [b for b in live if b not in used_ball and state["balls"][b]["x"] is not None],
        "rejected": [d for di, d in enumerate(detections) if di not in used_det],
    }


# ------------------------------------------------------------------ rules
def apply_shot(state: dict, pocketed: list[int], scratch: bool, intended: dict | None = None) -> dict:
    """
    Record the shot the current player just took (8-ball, simplified):
    - first shot that pockets only one group's balls assigns groups
    - pocketing the 8 wins only if your group was already cleared and you didn't scratch
    - you keep shooting if you pocketed one of yours (any object ball on an open table)
      without scratching; otherwise the turn passes
    `intended` is the shot they meant to play ({target, pocket, kind, cut_angle}), if
    known; otherwise the coach's suggestion, if they asked. It's what makes a shot count
    as made or missed in their long-term stats.
    Returns the event appended to history.
    """
    if state["winner"] is not None:
        raise GameError("This game is over. Start a new one.")
    pocketed = sorted(set(pocketed))
    for b in pocketed:
        if not 1 <= b <= 15:
            raise GameError(f"There's no ball {b}.")
        if state["balls"][str(b)]["status"] != "on":
            raise GameError(f"Ball {b} was already pocketed.")

    shooter = state["turn"]
    me, opp = state["players"][shooter], state["players"][1 - shooter]
    cleared_before = me["group"] is not None and not remaining(state, me["group"])
    for b in pocketed:
        state["balls"][str(b)]["status"] = "sunk"

    objects = [b for b in pocketed if b != 8]
    if 8 in pocketed:
        state["winner"] = shooter if cleared_before and not scratch else 1 - shooter
    elif me["group"] is None and objects and not scratch:
        kinds = {ball_type(b) for b in objects}
        if len(kinds) == 1:                      # both groups in one shot: table stays open
            me["group"] = kinds.pop()
            opp["group"] = "stripe" if me["group"] == "solid" else "solid"

    mine = [b for b in objects if me["group"] is None or ball_type(b) == me["group"]]
    keeps_turn = state["winner"] is None and not scratch and bool(mine)
    if not keeps_turn and state["winner"] is None:
        state["turn"] = 1 - shooter

    advice = state["last_advice"]
    if intended is None and advice and advice.get("target_ball") is not None:
        intended = {"target": advice["target_ball"], "pocket": advice.get("pocket"),
                    "kind": advice.get("kind"), "cut_angle": advice.get("cut_angle")}
    if intended is not None and advice and advice.get("target_ball") == intended.get("target"):
        intended = {**intended, "speed": advice.get("speed"), "spin": advice.get("spin")}
    event = {
        "t": time.time(),
        "player": me["name"],
        "pocketed": pocketed,
        "scratch": scratch,
        "result": ("won" if state["winner"] == shooter else "lost" if state["winner"] is not None
                   else "continues" if keeps_turn else "turn passes"),
        "intended": intended,
        "made": intended["target"] in pocketed if intended else None,
        "coached": advice is not None,
        "advice": advice and {
            "target_ball": advice.get("target_ball"),
            "pocket": advice.get("pocket"),
            "made": advice.get("target_ball") in pocketed,
        },
    }
    state["history"].append(event)
    state["last_advice"] = None
    return event


def public(state: dict) -> dict:
    """What the frontend sees: no internal fields (coach state), recent history only."""
    return {
        "id": state["_id"],
        "players": state["players"],
        "turn": state["turn"],
        "winner": state["winner"],
        "balls": {b: v["status"] for b, v in state["balls"].items()},
        "history": state["history"][-10:],
    }

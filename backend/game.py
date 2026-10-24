"""
CueIQ game memory: which balls are still on the table, whose turn it is, 8-ball rules.

Pure functions on a plain dict (stored as JSONB in Tiger Data), so they're easy to test.
The table state here is AUTHORITATIVE. Vision only proposes; this decides:
- Every detection is matched to a ball that's still on the table, using its color type,
  its read number, and where that ball was last seen. A pocketed ball can't come back,
  so a detection that looks like one gets matched to a ball still in play, or rejected.
- Detections left over after matching are rejected as false detections (glare, chalk,
  a hand...). There can't be more balls than the table has left.
- Except: a leftover detection that clearly IS a pocketed ball (vision is sure of its
  number) means that ball was only missed in an earlier photo. It comes back on the
  table, and the shot that "pocketed" it is corrected (revive). One bad photo shouldn't
  take a ball out of the game for good.

Shots are worked out from consecutive photos (process_photo): take a photo, shoot, take
the next photo. A ball seen in the last photo and gone from this one went in; the cue
ball gone means a scratch. If nothing went in and nothing moved, no shot was taken (a
retake). Balls not seen in EITHER photo stay in play: probably hidden, not pocketed.

Every photo can be corrected (the frontend's layout editor): the game rewinds to just
before that photo and replays it with the fixed layout (replace_photo), so a mistaken
"pocketed" never sticks.

The first photo is the racked table (all 15 balls plus the cue ball) and the next shot
is the break. A scratch gives the other player ball in hand: `ball_in_hand` stays set
until the cue ball shows up in a photo again or the next shot is played, and the coach
places the cue ball (physics.ball_in_hand) instead of using its old spot.
"""
import copy
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
REVIVE_CONFIDENCE = 0.7   # how sure vision must be of a pocketed ball's number to bring it back
UNSEEN_COST = 0.25        # position cost for a ball we have never seen yet
FOOT_SPOT = (750.0, 250.0)   # where a ball is spotted (the 8 pocketed on the break)
# Between two photos, if no ball moved more than this (table units), no shot was taken.
# Covers the jitter of shooting the same layout from a different spot.
MOVE_EPS = 20


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
        # seen: found in the latest photo. x, y: where it was last seen (None = never).
        "balls": {b: {"status": "on", "x": None, "y": None, "seen": False}
                  for b in ["cue", *map(str, range(1, 16))]},
        "history": [],               # one event per shot, newest last
        "last_advice": None,         # the coach's suggestion for the shot being played
        "photos": 0,                 # photos processed so far
        "photo": None,               # the latest photo's layout (what the editor shows)
        "undo": None,                # the state just before the latest photo, for corrections
        "ball_in_hand": False,       # after a scratch: the shooter may place the cue ball anywhere
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

    for b in live:
        state["balls"][b]["seen"] = b in used_ball
    balls = []
    for di, b, cost in matches:
        d = detections[di]
        state["balls"][b].update(x=d["x"], y=d["y"])
        conf = d["confidence"] if cost <= FLAG_COST else min(d["confidence"], 0.5)
        balls.append({
            "id": None if b == "cue" else int(b), "type": ball_type(b),
            "x": d["x"], "y": d["y"], "confidence": round(float(conf), 2),
        })
    revived = []
    for di, d in enumerate(detections):
        b = None if di in used_det or d.get("id") is None else str(d["id"])
        if b and b in state["balls"] and state["balls"][b]["status"] == "sunk" and b not in revived \
                and d["type"] == ball_type(b) and d["confidence"] >= REVIVE_CONFIDENCE \
                and not (b == "8" and state["winner"] is not None):
            revive(state, b, d["x"], d["y"])
            used_det.add(di)
            revived.append(b)
            # Flagged: the player should glance at it, since it changes an earlier shot.
            balls.append({"id": int(b), "type": ball_type(b), "x": d["x"], "y": d["y"],
                          "confidence": round(min(float(d["confidence"]), 0.5), 2)})
    return {
        "balls": balls,
        # Unmatched balls keep their last position, so x is set only if seen before.
        "missing": [b for b in live if b not in used_ball and state["balls"][b]["x"] is not None],
        "rejected": [d for di, d in enumerate(detections) if di not in used_det],
        "revived": [int(b) for b in revived],
    }


def revive(state: dict, b: str, x: float, y: float) -> None:
    """A ball marked pocketed turned up on the table: it was only missed in an earlier
    photo. Put it back in play and take it out of the shot that "pocketed" it. That shot's
    other effects (whose turn, groups) stand: the game moved on since, and a later
    correction in the editor is the way to change them."""
    state["balls"][b].update(status="on", x=x, y=y, seen=True)
    n = int(b)
    for e in reversed(state["history"]):
        if n in e["pocketed"]:
            e["pocketed"] = [p for p in e["pocketed"] if p != n]
            e.setdefault("revived", []).append(n)
            if e.get("intended") and e["intended"].get("target") == n:
                e["made"] = False
            break


def place(state: dict, layout: list[dict]) -> dict:
    """
    Like reconcile, but for a layout the player corrected: every ball's identity is given
    ({"id": 1-15, or null with "type": "cue"}), so it's trusted as-is. Same return shape.
    A ball marked pocketed earlier that the player put in the layout comes back (revive).
    """
    live = set(on_table(state))
    balls, used, revived = [], set(), []
    for item in layout:
        b = "cue" if item.get("type") == "cue" or item.get("id") is None else str(item["id"])
        if b not in state["balls"]:
            raise GameError(f"There's no ball {item.get('id')}.")
        if b not in live:
            if b == "8" and state["winner"] is not None:
                raise GameError("The 8 was pocketed and the game is over. Start a new one.")
            if b not in used:
                revive(state, b, float(item["x"]), float(item["y"]))
                revived.append(int(b))
        if b in used:
            raise GameError(f"Ball {'cue' if b == 'cue' else b} is in the layout twice.")
        used.add(b)
        state["balls"][b].update(x=float(item["x"]), y=float(item["y"]))
        balls.append({"id": None if b == "cue" else int(b), "type": ball_type(b),
                      "x": float(item["x"]), "y": float(item["y"]), "confidence": 1.0})
    for b in live:
        state["balls"][b]["seen"] = b in used
    return {
        "balls": balls,
        "missing": [b for b in live if b not in used and state["balls"][b]["x"] is not None],
        "rejected": [],
        "revived": revived,
    }


def _snapshot(state: dict) -> dict:
    return copy.deepcopy({k: v for k, v in state.items() if k != "undo"})


def process_photo(state: dict, detections: list[dict], *, corrected: bool = False,
                  intended: dict | None = None) -> dict:
    """
    A new photo of the table, taken after the balls stopped. Compared with the previous
    photo it tells us what the last shot did, which is applied to the game:
      pocketed = balls seen in the previous photo and gone now
      scratch  = the cue ball was seen in the previous photo and is gone now
    Nothing pocketed and nothing moved means no shot happened (a retake, or the first
    photo), so the turn doesn't change.
    `corrected`: the detections are a layout the player fixed by hand (see place).
    `intended`: the shot they went for, if the app knows it (see apply_shot).
    Returns {balls, missing, rejected, shot}: shot is the history event, or None.
    """
    state["undo"] = _snapshot(state)
    first = state["photo"] is None
    live = on_table(state)
    before = {b: (state["balls"][b]["x"], state["balls"][b]["y"])
              for b in live if state["balls"][b]["seen"]}

    in_hand = state.get("ball_in_hand", False)
    seen = place(state, detections) if corrected else reconcile(state, detections)
    now = {b for b in live if state["balls"][b]["seen"]}
    gone = [b for b in before if b not in now]
    pocketed = sorted(int(b) for b in gone if b != "cue")
    moved = max((math.hypot(state["balls"][b]["x"] - x, state["balls"][b]["y"] - y)
                 for b, (x, y) in before.items() if b in now), default=0.0)
    shot_taken = bool(pocketed) or moved > MOVE_EPS
    # Normally a scratch is the cue ball vanishing between photos. With ball in hand the
    # last photo had no cue ball (it was in the pocket), so: a shot was played and the cue
    # ball still isn't on the table.
    scratch = "cue" in gone or (in_hand and shot_taken and "cue" not in now)

    shot = None
    if not first and state["winner"] is None and (shot_taken or scratch):
        shot = apply_shot(state, pocketed, scratch, intended)
        shot["photo"] = state["photos"] + 1
    elif in_hand and "cue" in now:
        state["ball_in_hand"] = False     # placed and photographed: plan from where it is
    state["photos"] += 1
    state["photo"] = {"n": state["photos"], "balls": seen["balls"], "intended": intended}
    return {**seen, "shot": shot}


def replace_photo(state: dict, detections: list[dict], *, corrected: bool = False,
                  intended: dict | None = None) -> dict:
    """
    Redo the latest photo with different detections: a retake, or the player's fixed
    layout. Rewinds the game to just before that photo (undoing any shot it inferred),
    then processes this instead. The replaced photo's shot event, if any, is returned in
    `undone` so storage can drop it.
    """
    if state["undo"] is None:
        raise GameError("There's no photo to correct yet. Take a photo of the table first.")
    intended = intended or state["photo"].get("intended")   # keep what the player went for
    undone = state["history"][-1] if state["history"] and \
        state["history"][-1].get("photo") == state["photos"] else None
    snapshot = state["undo"]
    state.clear()
    state.update(snapshot)
    result = process_photo(state, detections, corrected=corrected, intended=intended)
    return {**result, "undone": undone}


# ------------------------------------------------------------------ rules
def apply_shot(state: dict, pocketed: list[int], scratch: bool, intended: dict | None = None) -> dict:
    """
    Record the shot the current player just took (8-ball, simplified):
    - the first shot of the game is the break: the table stays open whatever goes in,
      and an 8 pocketed on the break is spotted (put back), not a loss
    - after that, the first shot that pockets only one group's balls assigns groups
    - pocketing the 8 wins only if your group was already cleared and you didn't scratch
    - you keep shooting if you pocketed one of yours (any object ball on an open table)
      without scratching; otherwise the turn passes
    - a scratch gives the other player ball in hand
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
    is_break = not state["history"]
    spotted = is_break and 8 in pocketed
    for b in pocketed:
        if spotted and b == 8:
            state["balls"]["8"].update(x=FOOT_SPOT[0], y=FOOT_SPOT[1])   # back on the foot spot
            continue
        state["balls"][str(b)]["status"] = "sunk"

    objects = [b for b in pocketed if b != 8]
    if 8 in pocketed and not spotted:
        state["winner"] = shooter if cleared_before and not scratch else 1 - shooter
    elif is_break:
        pass                                     # the table stays open after the break
    elif me["group"] is None and objects and not scratch:
        kinds = {ball_type(b) for b in objects}
        if len(kinds) == 1:                      # both groups in one shot: table stays open
            me["group"] = kinds.pop()
            opp["group"] = "stripe" if me["group"] == "solid" else "solid"

    mine = [b for b in objects if me["group"] is None or ball_type(b) == me["group"]]
    keeps_turn = state["winner"] is None and not scratch and bool(mine)
    if not keeps_turn and state["winner"] is None:
        state["turn"] = 1 - shooter
    state["ball_in_hand"] = scratch and state["winner"] is None

    advice = state["last_advice"]
    if intended is None and advice and advice.get("target_ball") is not None:
        intended = {"target": advice["target_ball"], "pocket": advice.get("pocket"),
                    "kind": advice.get("kind"), "cut_angle": advice.get("cut_angle")}
    if intended is not None and advice and advice.get("target_ball") == intended.get("target"):
        spin_xy = advice.get("spin_xy") or {}
        intended = {**intended, "speed": advice.get("speed"), "spin": advice.get("spin"),
                    "power": advice.get("power"), "spin_x": spin_xy.get("x"), "spin_y": spin_xy.get("y")}
    event = {
        "t": time.time(),
        "player": me["name"],
        "pocketed": pocketed,
        "scratch": scratch,
        "break": is_break,
        "spotted": [8] if spotted else [],
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
        "ball_in_hand": state.get("ball_in_hand", False),
        "balls": {b: v["status"] for b, v in state["balls"].items()},
        "history": state["history"][-10:],
        # latest photo: {"n", "balls", "intended"}, or None before the first
        "layout": state["photo"],
    }

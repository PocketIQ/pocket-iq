"""
Spin and power: a simple physical model of the cue ball and object ball, used to pick
how hard to hit and where on the cue ball, and to preview where the cue ball goes.

Everything is in table units (1000 x 500, CONTRACT.md). On a 9ft table 1 unit = 2.54mm.

The model (good enough to choose follow vs draw and soft vs firm; not to the inch):
- Strike: power sets the cue ball's speed. Hitting above/below center (spin.y) gives
  follow/draw, left/right of center (spin.x) gives english.
- Sliding then rolling: a ball whose spin doesn't match its speed slides on the cloth
  (high friction) until it rolls naturally, then slows gently (rolling resistance).
  That's what makes draw work, and why it fades over long distances.
- Ball-ball contact: the object ball takes the cue ball's speed along the line of
  centers; the cue ball keeps the rest (the tangent line) plus its spin, which then
  bends its path forward (follow) or back (draw).
- Cushions: angle in = angle out (what the bank geometry assumes), losing speed; the
  ball's spin bounces with it. English bends the rebound angle.
Not modeled: squirt, swerve, throw, cushion height, jumps.

The planner tries a small grid of power and spin for each candidate shot, keeps the
ones that pocket the ball, and picks the one leaving the cue ball where the player's
next shot is easiest.
"""
import math
from dataclasses import dataclass, field

TABLE_W, TABLE_H = 1000, 500
R = 11                                  # ball radius (BALL_RADIUS in vision.py)

M_PER_UNIT = 0.00254                    # 9ft table: 100in = 1000 units
G = 9.81 / M_PER_UNIT                   # gravity, units/s^2
MU_SLIDE = 0.2                          # cloth friction while a ball slides
MU_ROLL = 0.01                          # rolling resistance
E_BALL = 0.95                           # ball-ball restitution
E_CUSHION = 0.75                        # share of speed kept off a cushion
V_MAX = 8.0 / M_PER_UNIT                # power 1.0 = 8 m/s: a hard break
TIP_MAX = 0.5                           # spin 1.0 = cue tip half a radius off center
ENGLISH_GAIN = 0.25                     # how much english bends a cushion rebound
ARRIVE_SPEED = 0.15 / M_PER_UNIT        # object ball must still be moving at the pocket
CORNER_CAPTURE = 2.2 * R                # a ball center this close to a pocket drops
SIDE_CAPTURE = 1.9 * R
# Pocket mouths: the cushion stops this far from a pocket along the rail (a corner
# mouth runs along both rails). A ball crossing the rail line there drops.
CORNER_MOUTH = 4.5 * R
SIDE_MOUTH = 2.4 * R
EPS = 1e-6

# Speed at which a ball is considered stopped (units/s).
STOPPED = 2.0


# ===================================================== geometry (port of shots.ts)
# Same rules as frontend/src/physics/shots.ts: ghost-ball aiming, one-cushion banks,
# clear-path checks. Keep the two in sync.

@dataclass
class Pocket:
    name: str
    x: float
    y: float
    side: bool


def pockets(W: float = TABLE_W, H: float = TABLE_H) -> list[Pocket]:
    return [
        Pocket("top_left", 0, 0, False), Pocket("top_side", W / 2, 0, True),
        Pocket("top_right", W, 0, False), Pocket("bottom_left", 0, H, False),
        Pocket("bottom_side", W / 2, H, True), Pocket("bottom_right", W, H, False),
    ]


def _sub(a, b): return (a[0] - b[0], a[1] - b[1])
def _add(a, b): return (a[0] + b[0], a[1] + b[1])
def _mul(a, k): return (a[0] * k, a[1] * k)
def _dot(a, b): return a[0] * b[0] + a[1] * b[1]
def _len(a): return math.hypot(a[0], a[1])


def _unit(a):
    n = _len(a) or 1.0
    return (a[0] / n, a[1] / n)


def dist_to_segment(p, a, b) -> float:
    ab = _sub(b, a)
    t = max(0.0, min(1.0, _dot(_sub(p, a), ab) / (_dot(ab, ab) or 1.0)))
    return _len(_sub(p, _add(a, _mul(ab, t))))


def _clear(a, b, balls: list[dict], skip: set[int]) -> bool:
    return all(i in skip or dist_to_segment((bl["x"], bl["y"]), a, b) >= 2 * R
               for i, bl in enumerate(balls))


def _cut_deg(cue, ghost, target, aim_at) -> float:
    c = _dot(_unit(_sub(ghost, cue)), _unit(_sub(aim_at, target)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _cross_y(a, b, Y):
    if (a[1] - Y) * (b[1] - Y) > 0 or a[1] == b[1]:
        return None
    t = (Y - a[1]) / (b[1] - a[1])
    return (a[0] + t * (b[0] - a[0]), Y)


def _cross_x(a, b, X):
    if (a[0] - X) * (b[0] - X) > 0 or a[0] == b[0]:
        return None
    t = (X - a[0]) / (b[0] - a[0])
    return (X, a[1] + t * (b[1] - a[1]))


def legal_targets(balls: list[dict], group: str | None) -> list[int]:
    idx = range(len(balls))
    if group is None:
        return [i for i in idx if balls[i]["type"] in ("solid", "stripe")]
    mine = [i for i in idx if balls[i]["type"] == group]
    return mine or [i for i in idx if balls[i]["type"] == "eight"]


@dataclass
class Shot:
    target_index: int
    target_id: int | None
    pocket: Pocket
    kind: str                     # "direct" | "bank"
    ghost: tuple
    aim_at: tuple                 # the pocket, or its mirror image for a bank
    bank: tuple | None
    cut: float
    difficulty: float


def find_shots(balls: list[dict], group: str | None, *, cue: tuple | None = None,
               banks: bool = True, W: float = TABLE_W, H: float = TABLE_H) -> list[Shot]:
    """All makeable shots at a legal ball, easiest first (port of findShots).
    `cue` overrides the cue ball position (used to score the NEXT shot)."""
    cue_i = next((i for i, b in enumerate(balls) if b["type"] == "cue"), None)
    if cue is None:
        if cue_i is None:
            return []
        cue = (balls[cue_i]["x"], balls[cue_i]["y"])
    diag = math.hypot(W, H)
    shots: list[Shot] = []

    def try_shot(ti, target, pocket, aim_at, bank):
        ghost = _sub(target, _mul(_unit(_sub(aim_at, target)), 2 * R))
        if not (R <= ghost[0] <= W - R and R <= ghost[1] <= H - R):
            return
        cut = _cut_deg(cue, ghost, target, aim_at)
        if cut > 75:
            return
        final_leg = _sub((pocket.x, pocket.y), bank or target)
        if pocket.side and abs(_unit(final_leg)[1]) < 0.5:
            return
        skip = {ti} | ({cue_i} if cue_i is not None else set())
        if not _clear(cue, ghost, balls, skip):
            return
        if bank:
            if not (_clear(target, bank, balls, skip) and _clear(bank, (pocket.x, pocket.y), balls, skip)):
                return
        elif not _clear(target, (pocket.x, pocket.y), balls, skip):
            return
        travel = _len(_sub(ghost, cue)) + (_len(_sub(bank, target)) + _len(_sub((pocket.x, pocket.y), bank))
                                           if bank else _len(_sub((pocket.x, pocket.y), target)))
        difficulty = (0.55 * (cut / 75) ** 1.5 + 0.3 * travel / diag
                      + (0.25 if bank else 0) + (0.05 if pocket.side else 0))
        shots.append(Shot(ti, balls[ti]["id"], pocket, "bank" if bank else "direct",
                          ghost, aim_at, bank, cut, difficulty))

    for ti in legal_targets(balls, group):
        target = (balls[ti]["x"], balls[ti]["y"])
        for p in pockets(W, H):
            pp = (p.x, p.y)
            try_shot(ti, target, p, pp, None)
            if not banks:
                continue
            cushions = [
                (lambda q: (q[0], 2 * R - q[1]), lambda a, b: _cross_y(a, b, R)),
                (lambda q: (q[0], 2 * (H - R) - q[1]), lambda a, b: _cross_y(a, b, H - R)),
                (lambda q: (2 * R - q[0], q[1]), lambda a, b: _cross_x(a, b, R)),
                (lambda q: (2 * (W - R) - q[0], q[1]), lambda a, b: _cross_x(a, b, W - R)),
            ]
            for mirror, hit in cushions:
                m = mirror(pp)
                if _len(_sub(m, pp)) < 4 * R:
                    continue
                bank = hit(target, m)
                if not bank or not (R <= bank[0] <= W - R and R <= bank[1] <= H - R):
                    continue
                try_shot(ti, target, p, m, bank)
    return sorted(shots, key=lambda s: s.difficulty)


# ================================================================= ball motion
@dataclass
class Motion:
    """Where a ball went: path points, where it stopped, and what happened on the way."""
    path: list[tuple] = field(default_factory=list)
    stop: tuple = (0.0, 0.0)
    pocket: str | None = None         # pocket it dropped into
    kissed: int | None = None         # index of a ball it ran into (simulation stops there)
    cushions: int = 0
    speed_at_pocket: float = 0.0


def _capture(p) -> Pocket | None:
    off_table = not (R - 0.5 <= p[0] <= TABLE_W - R + 0.5 and R - 0.5 <= p[1] <= TABLE_H - R + 0.5)
    nearest = min(pockets(), key=lambda pk: math.hypot(p[0] - pk.x, p[1] - pk.y))
    if off_table:   # past the rail line: only possible through a pocket mouth
        return nearest
    reach = SIDE_CAPTURE if nearest.side else CORNER_CAPTURE
    return nearest if math.hypot(p[0] - nearest.x, p[1] - nearest.y) < reach else None


def _in_mouth(axis: int, along: float) -> bool:
    """Is this spot on a rail (axis 0: a short rail, at height `along`; axis 1: a long
    rail, at x = `along`) inside a pocket mouth, where there's no cushion?"""
    length = TABLE_H if axis == 0 else TABLE_W
    if along < CORNER_MOUTH or along > length - CORNER_MOUTH:
        return True
    return axis == 1 and abs(along - TABLE_W / 2) < SIDE_MOUTH


def roll(p, v, w, side: float = 0.0, *, obstacles: list[tuple] = (), max_cushions: int = 6) -> Motion:
    """
    Move a ball until it stops, drops, or hits another ball.
    p, v: position and velocity. w: its spin, as the velocity it would have if rolling
    with that spin (w == v means natural roll; w = 0 is a stun/slide). side: english,
    as the equator's speed (positive = right english).
    Exact piecewise motion: each phase (sliding or rolling) has constant deceleration,
    so positions are parabolas; cushion hits are found by solving for when they cross.
    """
    out = Motion(path=[tuple(p)])
    p, v, w = tuple(p), tuple(v), tuple(w)
    for _ in range(60):
        slip = _sub(v, w)
        if _len(slip) > STOPPED:                     # sliding: friction against the slip
            s_hat = _unit(slip)
            a = _mul(s_hat, -MU_SLIDE * G)
            dw = _mul(s_hat, 2.5 * MU_SLIDE * G)     # spin is dragged toward the motion
            T = _len(slip) / (3.5 * MU_SLIDE * G)
        else:                                        # rolling: gentle slowdown
            if _len(v) < STOPPED:
                break
            a = _mul(_unit(v), -MU_ROLL * G)
            dw = None
            T = _len(v) / (MU_ROLL * G)

        # Earliest cushion this phase reaches (ball center hits a line R inside the rail).
        t_hit, wall = T, None
        for axis, line, normal in ((0, R, 1), (0, TABLE_W - R, -1), (1, R, 1), (1, TABLE_H - R, -1)):
            # solve p + v t + a t^2 / 2 = line, moving toward the wall
            A, B, C = 0.5 * a[axis], v[axis], p[axis] - line
            roots = []
            if abs(A) < EPS:
                if abs(B) > EPS:
                    roots = [-C / B]
            else:
                disc = B * B - 4 * A * C
                if disc >= 0:
                    sq = math.sqrt(disc)
                    roots = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]
            for t in roots:
                if 1e-7 < t < t_hit and (v[axis] + a[axis] * t) * normal < 0:
                    other = 1 - axis
                    along = p[other] + v[other] * t + 0.5 * a[other] * t * t
                    if not _in_mouth(axis, along):   # no cushion in a pocket mouth
                        t_hit, wall = t, (axis, normal)

        # Walk the phase in small steps: record the path, check pockets and other balls.
        steps = max(2, int(_len(v) * t_hit / 12) + 1)
        for k in range(1, steps + 1):
            t = t_hit * k / steps
            q = (p[0] + v[0] * t + 0.5 * a[0] * t * t, p[1] + v[1] * t + 0.5 * a[1] * t * t)
            out.path.append(q)
            pk = _capture(q)
            if pk:
                out.pocket, out.stop = pk.name, q
                out.speed_at_pocket = _len(_add(v, _mul(a, t)))
                return out
            for i, o in enumerate(obstacles):
                if math.hypot(q[0] - o[0], q[1] - o[1]) < 2 * R:
                    out.kissed, out.stop = i, q
                    return out

        t = t_hit
        p = (p[0] + v[0] * t + 0.5 * a[0] * t * t, p[1] + v[1] * t + 0.5 * a[1] * t * t)
        v = _add(v, _mul(a, t))
        w = _add(w, _mul(dw, t)) if dw is not None else v
        if wall is None:
            if dw is None:          # rolled to a stop
                break
            continue                # slide ended: now rolling
        axis, normal = wall
        out.cushions += 1
        if out.cushions > max_cushions:
            break
        d_in = _unit(v)
        flip = (lambda u: (-u[0] * E_CUSHION, u[1] * E_CUSHION)) if axis == 0 else \
               (lambda u: (u[0] * E_CUSHION, -u[1] * E_CUSHION))
        v, w = flip(v), flip(w)
        if side:   # english pushes the rebound toward its side of the incoming direction
            right = (-d_in[1], d_in[0])
            v = _add(v, _mul(right, ENGLISH_GAIN * side))
            side *= 0.5
    out.stop = p
    return out


def _travel(V: float, wd: float, D: float) -> tuple[float, float] | None:
    """Cue ball going straight: start speed V and spin wd (same units), distance D.
    Returns (speed, spin) on arrival, or None if it stops first. 1D version of roll."""
    v, w, left = V, wd, D
    for _ in range(4):
        slip = v - w
        if abs(slip) > STOPPED:
            sgn = 1 if slip > 0 else -1
            a, dw, T = -MU_SLIDE * G * sgn, 2.5 * MU_SLIDE * G * sgn, abs(slip) / (3.5 * MU_SLIDE * G)
        else:
            if v < STOPPED:
                return None
            a, dw, T = -MU_ROLL * G, None, v / (MU_ROLL * G)
        dist = v * T + 0.5 * a * T * T
        if dist >= left:   # arrives during this phase
            disc = v * v + 2 * a * left
            if disc < 0:
                return None
            t = (-v + math.sqrt(disc)) / a if abs(a) > EPS else left / v
            return v + a * t, (w + dw * t) if dw is not None else v + a * t
        left -= dist
        v += a * T
        w = (w + dw * T) if dw is not None else v
        if dw is None or v < STOPPED:
            return None
    return None


# ================================================================ one shot, simulated
@dataclass
class Result:
    power: float
    spin: tuple                       # (x, y), each -1..1
    made: bool                        # object ball dropped in the intended pocket
    scratch: bool
    kissed: bool                      # cue ball ran into another ball after contact
    cue_path: list[tuple]
    cue_stop: tuple
    object_path: list[tuple]


def simulate(balls: list[dict], shot: Shot, power: float, spin: tuple, *,
             object_only: bool = False) -> Result:
    """Strike the cue ball at `power` (0-1) with `spin` (x, y) toward the shot's ghost ball.
    object_only: skip the cue ball after contact (when only `made` matters)."""
    cue_i = next(i for i, b in enumerate(balls) if b["type"] == "cue")
    cue = (balls[cue_i]["x"], balls[cue_i]["y"])
    target = (balls[shot.target_index]["x"], balls[shot.target_index]["y"])
    V = max(0.0, min(1.0, power)) * V_MAX
    sx, sy = (max(-1.0, min(1.0, s)) for s in spin)
    aim = _unit(_sub(shot.ghost, cue))
    # Cue tip height b (fraction of R) above center gives spin w = (5/2) b V: natural roll
    # at b = 2/5, stun at 0, draw below.
    arrive = _travel(V, 2.5 * TIP_MAX * sy * V, _len(_sub(shot.ghost, cue)))
    if arrive is None:   # never reaches the object ball
        stop = roll(cue, _mul(aim, V), _mul(aim, 2.5 * TIP_MAX * sy * V))
        return Result(power, (sx, sy), False, bool(stop.pocket), False, stop.path, stop.stop, [target])
    vc, wc = arrive
    v_in = _mul(aim, vc)
    n = _unit(_sub(target, shot.ghost))                 # line of centers at contact
    vn = _dot(v_in, n) * (1 + E_BALL) / 2
    v_obj = _mul(n, vn)
    v_cue = _sub(v_in, v_obj)
    others = [(b["x"], b["y"]) for i, b in enumerate(balls) if i not in (cue_i, shot.target_index)]

    # The object ball's path is already checked clear by find_shots.
    obj = roll(target, v_obj, (0.0, 0.0), max_cushions=1 if shot.kind == "bank" else 0)
    made = obj.pocket == shot.pocket.name and obj.speed_at_pocket >= ARRIVE_SPEED
    if object_only:
        return Result(power, (sx, sy), made, False, False, [cue, shot.ghost], shot.ghost, obj.path)
    resting = [] if obj.pocket else [obj.stop]
    cue_after = roll(shot.ghost, v_cue, _mul(aim, wc), 2.5 * TIP_MAX * sx * V, obstacles=others + resting)
    return Result(power, (sx, sy), made, bool(cue_after.pocket), cue_after.kissed is not None,
                  [cue, *cue_after.path], cue_after.stop, obj.path)


# ================================================================ choosing power and spin
POWER_STEPS = (1.15, 1.5, 2.0, 2.8)            # multiples of the minimum that pockets the ball
SPINS = [(0.0, -1.0), (0.0, -0.5), (0.0, 0.0), (0.0, 0.5), (0.0, 1.0), (-0.6, 0.0), (0.6, 0.0)]


@dataclass
class Plan:
    power: float
    spin: tuple
    cue_path: list[tuple]
    cue_stop: tuple
    object_path: list[tuple]
    scratch: bool
    next_shot: Shot | None           # easiest follow-up shot from where the cue ball stops
    score: float                     # lower is better


def _min_power(balls, shot, spin) -> float | None:
    """Smallest power that still drops the ball (binary search)."""
    if not simulate(balls, shot, 1.0, spin, object_only=True).made:
        return None
    lo, hi = 0.02, 1.0
    for _ in range(9):
        mid = (lo + hi) / 2
        if simulate(balls, shot, mid, spin, object_only=True).made:
            hi = mid
        else:
            lo = mid
    return hi


def _next_group(target: dict, group: str | None) -> str | None:
    if group is not None or target["type"] not in ("solid", "stripe"):
        return group
    return target["type"]     # pocketing it on an open table claims that group


def plan(balls: list[dict], shot: Shot, group: str | None) -> Plan | None:
    """Best power and spin for this shot: pockets the ball, doesn't scratch, and leaves the
    easiest next shot. None if no tried combination pockets it."""
    target = balls[shot.target_index]
    after = [b for i, b in enumerate(balls) if i != shot.target_index]
    nxt_group = _next_group(target, group)
    best: Plan | None = None
    for spin in SPINS:
        base = _min_power(balls, shot, spin)
        if base is None:
            continue
        for k in POWER_STEPS:
            power = base * k
            if power > 1.0:
                break
            r = simulate(balls, shot, power, spin)
            if not r.made:
                continue
            nxt = None
            if not r.scratch:
                nxt = next(iter(find_shots(after, nxt_group, cue=r.cue_stop, banks=False)), None)
            score = ((10.0 if r.scratch else 0.0) + (0.4 if r.kissed else 0.0)
                     + (nxt.difficulty if nxt else 1.2)
                     + 0.15 * power + 0.05 * abs(spin[0]) + 0.03 * abs(spin[1]))   # prefer simple
            if best is None or score < best.score:
                best = Plan(round(power, 2), spin, r.cue_path, r.cue_stop, r.object_path,
                            r.scratch, nxt, score)
    return best


# ================================================================ words for the coach
def speed_word(power: float) -> str:
    return "soft" if power < 0.2 else "medium" if power < 0.4 else "firm" if power < 0.65 else "hard"


def spin_word(spin: tuple) -> str:
    x, y = spin
    if abs(x) >= 0.3 and abs(x) >= abs(y):
        return "right english" if x > 0 else "left english"
    if y >= 0.25:
        return "follow"
    if y <= -0.25:
        return "draw"
    return "center"


# The other way, for advice without a physics plan (a guess from the coach's words).
WORD_POWER = {"soft": 0.15, "medium": 0.3, "firm": 0.5, "hard": 0.75}
WORD_SPIN = {"center": (0.0, 0.0), "stop": (0.0, -0.3), "follow": (0.0, 0.6), "draw": (0.0, -0.6),
             "left english": (-0.6, 0.0), "right english": (0.6, 0.0)}


def _pts(path: list[tuple], step: int = 2) -> list[dict]:
    """Thin a path for the response: every `step`-th point, always keeping the ends."""
    keep = path[::step] + ([path[-1]] if (len(path) - 1) % step else [])
    return [{"x": round(x, 1), "y": round(y, 1)} for x, y in keep]


def plan_json(p: Plan) -> dict:
    return {
        "planned": True,
        "power": p.power,
        "spin": {"x": p.spin[0], "y": p.spin[1]},
        "cue_path": _pts(p.cue_path),
        "cue_stop": {"x": round(p.cue_stop[0], 1), "y": round(p.cue_stop[1], 1)},
        "object_path": _pts(p.object_path),
        "scratch": p.scratch,
        "next_shot": p.next_shot and {
            "target_ball": p.next_shot.target_id, "pocket": p.next_shot.pocket.name,
            "cut_angle": round(p.next_shot.cut),
        },
    }


def result_json(r: Result) -> dict:
    return {
        "planned": False,
        "power": round(r.power, 2), "spin": {"x": r.spin[0], "y": r.spin[1]},
        "made": r.made, "scratch": r.scratch, "kissed": r.kissed,
        "cue_path": _pts(r.cue_path),
        "cue_stop": {"x": round(r.cue_stop[0], 1), "y": round(r.cue_stop[1], 1)},
        "object_path": _pts(r.object_path),
    }


# ================================================================ game state glue
def balls_from_state(state: dict) -> list[dict]:
    """Balls still in play with a known position, in the shape find_shots expects."""
    out = []
    for b, v in state["balls"].items():
        if v["status"] == "on" and v["x"] is not None:
            t = "cue" if b == "cue" else "eight" if b == "8" else "solid" if int(b) < 8 else "stripe"
            out.append({"id": None if b == "cue" else int(b), "type": t, "x": v["x"], "y": v["y"]})
    return out


def match_shot(balls: list[dict], group: str | None, target_id: int, pocket: str, kind: str,
               cut_angle: float | None = None) -> Shot | None:
    """Find the geometry for a candidate the frontend described (target, pocket, kind)."""
    found = [s for s in find_shots(balls, group)
             if s.target_id == target_id and s.pocket.name == pocket and s.kind == kind]
    if not found:
        return None
    return min(found, key=lambda s: abs(s.cut - cut_angle)) if cut_angle is not None else found[0]

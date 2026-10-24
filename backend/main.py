"""CueIQ backend. Photo in, balls out; plus game memory and the coach (see CONTRACT.md)."""
import os

from dotenv import load_dotenv

load_dotenv()  # reads backend/.env into os.environ

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel, Field, ValidationError, field_validator  # noqa: E402

import ball_id  # noqa: E402
import coach  # noqa: E402
import game  # noqa: E402
import physics  # noqa: E402
import store  # noqa: E402
import voice  # noqa: E402
from vision import BALL_RADIUS, TABLE_H, TABLE_W, VisionError, analyze_image  # noqa: E402

app = FastAPI(title="PocketIQ API")

origins = os.getenv("FRONTEND_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


async def _read_photo(photo: UploadFile) -> np.ndarray:
    data = await photo.read()
    if not data:
        raise HTTPException(400, "Photo is empty.")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Couldn't read that file as an image. Send a JPEG or PNG.")
    return img


def _vision(img: np.ndarray, allowed: set[str] | None = None) -> tuple[list[dict], list[dict]]:
    """CV finds the balls, Gemini double-checks what each one is. Returns (balls, not-balls).
    allowed: the balls still in play, so vision never names a pocketed one."""
    try:
        result = analyze_image(img, allowed)
    except VisionError as e:
        # 422 = "I understood the request but can't use this photo". Frontend shows the message.
        raise HTTPException(422, str(e))
    return ball_id.identify(result.warped, result.balls)


def _load(game_id: str) -> dict:
    try:
        return store.load_game(game_id)
    except game.GameError as e:
        raise HTTPException(404, str(e))
    except store.StoreError as e:
        raise HTTPException(503, str(e))


def _save(state: dict) -> None:
    try:
        store.save_game(state)
    except store.StoreError as e:
        raise HTTPException(503, str(e))


@app.post("/analyze")
async def analyze(photo: UploadFile = File(...)):
    """Stateless: just what's in this photo. Use /games/{id}/analyze during a game."""
    balls, _ = _vision(await _read_photo(photo))
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": balls,
    }


# ------------------------------------------------------------------ games
class NewGame(BaseModel):
    players: list[str] = Field(min_length=2, max_length=2)

    @field_validator("players")
    @classmethod
    def names(cls, v: list[str]) -> list[str]:
        v = [n.strip() for n in v]
        if not all(v):
            raise ValueError("Both players need a name.")
        if v[0].lower() == v[1].lower():
            raise ValueError("Players need different names.")
        return v


class Intended(BaseModel):
    """The shot the player meant to play (the one selected in the app)."""
    target: int = Field(ge=1, le=15)
    pocket: str
    kind: str
    cut_angle: float


class LayoutBall(BaseModel):
    """One ball in a layout the player corrected: its identity is trusted as given."""
    id: int | None = Field(default=None, ge=1, le=15)   # null = the cue ball
    type: str | None = None                              # "cue" for the cue ball; else optional
    x: float = Field(ge=0, le=TABLE_W)
    y: float = Field(ge=0, le=TABLE_H)


class Layout(BaseModel):
    balls: list[LayoutBall] = Field(max_length=16)
    intended: Intended | None = None


class GutterBall(BaseModel):
    """One pocketed ball, and who it counts for."""
    ball: int = Field(ge=1, le=15)
    by: int | None = Field(default=None, ge=0, le=1)   # index into players; null = no one
    member: str | None = Field(default=None, max_length=40)
    photo: int | None = None
    open: bool = False


class Gutter(BaseModel):
    pocketed: list[GutterBall] = Field(max_length=15)
    balls: list[LayoutBall] | None = Field(default=None, max_length=16)


class Candidate(BaseModel):
    """One shot from the frontend's shot finder (frontend/src/physics/shots.ts)."""
    index: int
    target_id: int
    pocket: str
    kind: str
    cut_angle: float
    difficulty: float
    cue_distance: float
    target_distance: float


class AdviceRequest(BaseModel):
    candidates: list[Candidate] = Field(max_length=12)


class Spin(BaseModel):
    x: float = Field(0.0, ge=-1, le=1)   # -1 left english .. 1 right english
    y: float = Field(0.0, ge=-1, le=1)   # -1 full draw .. 1 full follow


class SimulateRequest(BaseModel):
    """A shot from the shot finder, struck with this power and spin."""
    target_id: int = Field(ge=1, le=15)
    pocket: str
    kind: str = "direct"
    cut_angle: float | None = None       # picks between banks off different cushions
    power: float = Field(ge=0, le=1)
    spin: Spin = Spin()


class PlanBall(BaseModel):
    id: int | None = Field(default=None, ge=1, le=15)   # null = the cue ball
    type: str                                            # "cue" | "eight" | "solid" | "stripe"
    x: float = Field(ge=0, le=TABLE_W)
    y: float = Field(ge=0, le=TABLE_H)


class PlanRequest(BaseModel):
    """A layout and a shot from the shot finder. No game needed."""
    balls: list[PlanBall] = Field(max_length=16)
    group: str | None = None             # the shooter's group; null = open table
    target_id: int = Field(ge=1, le=15)
    pocket: str
    kind: str = "direct"
    cut_angle: float | None = None


@app.post("/games")
def create_game(body: NewGame):
    state = game.new_game(body.players)
    _save(state)
    return game.public(state)


@app.get("/games/{game_id}")
def get_game(game_id: str):
    return game.public(_load(game_id))


def _photo_result(state: dict, result: dict, not_balls: list[dict] = ()) -> dict:
    try:   # the game + the coach's long-term memory, together
        store.save_photo(state, result["shot"], result.get("undone"))
    except store.StoreError as e:
        raise HTTPException(503, str(e))
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": result["balls"],
        "missing": result["missing"],
        "rejected": result["rejected"] + list(not_balls),
        "revived": result.get("revived", []),
        "shot": result["shot"],
        "game": game.public(state),
    }


@app.post("/games/{game_id}/analyze")
async def analyze_in_game(
    game_id: str,
    photo: UploadFile = File(...),
    intended: str | None = Form(None),
    retake: bool = Form(False),
):
    """
    The next photo of the table, taken once the balls stop. Checked against the game's
    memory (only balls still in play can be detected, each keeps its identity), and
    compared with the previous photo to work out the shot in between: balls that
    disappeared went in, a missing cue ball is a scratch. That shot is applied to the
    game (turns, groups, winner) and returned as `shot`.
    `intended`: JSON of the shot the player went for (makes their stats count it).
    `retake`: this photo replaces the latest one instead of following it.
    """
    state = _load(game_id)
    try:
        meant = Intended.model_validate_json(intended).model_dump() if intended else None
    except ValidationError as e:
        raise HTTPException(422, f"`intended` isn't a valid shot: {e.errors()[0]['msg']}")
    # Vision names balls freely (all 16); the game's memory decides. Restricting names to
    # balls in play hid a ball that one bad photo had wrongly marked pocketed: this way
    # it's seen again and brought back (game.revive).
    balls, not_balls = _vision(await _read_photo(photo))
    try:
        if retake:
            result = game.replace_photo(state, balls, intended=meant)
        else:
            result = game.process_photo(state, balls, intended=meant)
    except game.GameError as e:
        raise HTTPException(409, str(e))
    return _photo_result(state, result, not_balls)


@app.put("/games/{game_id}/layout")
def correct_layout(game_id: str, body: Layout):
    """
    The player fixed the latest photo's layout (moved, relabeled, added or removed balls).
    The game rewinds to before that photo and replays it with this layout, so the shot
    it showed (what went in, scratch, whose turn) is recomputed from the corrected balls.
    """
    state = _load(game_id)
    try:
        result = game.replace_photo(state, [b.model_dump() for b in body.balls], corrected=True,
                                    intended=body.intended and body.intended.model_dump())
    except game.GameError as e:
        raise HTTPException(409, str(e))
    return _photo_result(state, result)


@app.put("/games/{game_id}/pocketed")
def correct_pocketed(game_id: str, body: Gutter):
    """
    The player fixed the gutter: exactly these balls are pocketed, in this order, each
    counting for whoever `by` says. `balls`: the latest photo's layout with that change
    made (a ball put in the gutter taken off the table, one taken out placed back on).
    """
    state = _load(game_id)
    try:
        seen = game.set_gutter(state, [g.model_dump() for g in body.pocketed],
                               body.balls and [b.model_dump() for b in body.balls])
    except game.GameError as e:
        raise HTTPException(409, str(e))
    _save(state)
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        **seen,
        "shot": None,
        "game": game.public(state),
    }


@app.post("/games/{game_id}/advice")
def advice(game_id: str, body: AdviceRequest):
    """Which shot to take and how, for the player whose turn it is."""
    state = _load(game_id)
    if state["winner"] is not None:
        raise HTTPException(409, "This game is over. Start a new one.")
    try:
        result = coach.advise(state, [c.model_dump() for c in body.candidates])
    except coach.CoachError as e:
        raise HTTPException(502, str(e))
    _save(state)   # keeps the suggestion, so the next photo's shot knows it was coached
    return result


@app.post("/games/{game_id}/simulate")
def simulate(game_id: str, body: SimulateRequest):
    """
    What happens if the current player hits this shot with this power and spin: does the
    ball drop, where does the cue ball go and stop, does it scratch. For previewing the
    spin indicator and power bar live. Uses the game's latest layout.
    """
    state = _load(game_id)
    group = state["players"][state["turn"]]["group"]
    balls = physics.balls_from_state(state)
    if state.get("ball_in_hand"):
        raise HTTPException(409, "Ball in hand: place the cue ball (see /plan/ball-in-hand) "
                                 "and take a photo, then simulate from there.")
    if not any(b["type"] == "cue" for b in balls):
        raise HTTPException(409, "The cue ball hasn't been seen yet. Take a photo of the table first.")
    shot = physics.match_shot(balls, group, body.target_id, body.pocket, body.kind, body.cut_angle)
    if shot is None:
        raise HTTPException(409, "That shot isn't open from this layout.")
    result = physics.simulate(balls, shot, body.power, (body.spin.x, body.spin.y))
    return {
        **physics.result_json(result),
        "speed": physics.speed_word(body.power),
        "spin_name": physics.spin_word((body.spin.x, body.spin.y)),
    }


@app.post("/plan")
def plan_shot(body: PlanRequest):
    """
    Physics only: the best power and spin for this shot from this layout (pockets it, no
    scratch, easiest next shot). No game, database or Gemini, so it works for any layout
    the frontend has, including its test table. `physics` is null if nothing tried pockets it.
    """
    balls = [b.model_dump() for b in body.balls]
    if not any(b["type"] == "cue" for b in balls):
        raise HTTPException(409, "There's no cue ball in this layout.")
    shot = physics.match_shot(balls, body.group, body.target_id, body.pocket, body.kind, body.cut_angle)
    if shot is None:
        raise HTTPException(409, "That shot isn't open from this layout.")
    p = physics.plan(balls, shot, body.group)
    if p is None:
        return {"physics": None, "speed": None, "spin_name": None}
    return {"physics": physics.plan_json(p), "speed": physics.speed_word(p.power),
            "spin_name": physics.spin_word(p.spin)}


class HandRequest(BaseModel):
    """A layout after a scratch: where should the cue ball go? Its old spot is ignored."""
    balls: list[PlanBall] = Field(max_length=16)
    group: str | None = None             # the shooter's group; null = open table


@app.post("/plan/ball-in-hand")
def plan_ball_in_hand(body: HandRequest):
    """
    Ball in hand (after the opponent scratched): the best spot for the cue ball, the shot
    from there, and its power, spin and cue ball path. Physics only, like /plan. Every
    field is null if no spot gives a makeable shot (play safe).
    """
    h = physics.ball_in_hand([b.model_dump() for b in body.balls], body.group)
    if h is None:
        return {"cue": None, "target_ball": None, "pocket": None, "kind": None, "cut_angle": None,
                "physics": None, "speed": None, "spin_name": None}
    return physics.hand_json(h)


@app.get("/games/{game_id}/advice/audio")
def advice_audio(game_id: str):
    """The latest advice read aloud (ElevenLabs), as MP3. Ask for /advice first."""
    state = _load(game_id)
    if not state["last_advice"]:
        raise HTTPException(409, "Ask the coach first.")
    try:
        audio = voice.speak(coach.speech(state["last_advice"]))
    except voice.VoiceError as e:
        raise HTTPException(502, str(e))
    return Response(audio, media_type="audio/mpeg")


@app.get("/players/{name}/stats")
def stats(name: str):
    """How this player shoots, from every shot they've taken (Tiger Data)."""
    try:
        return store.player_stats(name)
    except store.StoreError as e:
        raise HTTPException(503, str(e))

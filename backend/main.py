"""CueIQ backend. Photo in, balls out; plus game memory and the coach (see CONTRACT.md)."""
import os

from dotenv import load_dotenv

load_dotenv()  # reads backend/.env into os.environ

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel, Field, field_validator  # noqa: E402

import ball_id  # noqa: E402
import coach  # noqa: E402
import game  # noqa: E402
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


def _vision(img: np.ndarray) -> tuple[list[dict], list[dict]]:
    """CV finds the balls, Gemini double-checks what each one is. Returns (balls, not-balls)."""
    try:
        result = analyze_image(img)
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


class ShotResult(BaseModel):
    pocketed: list[int] = []
    scratch: bool = False
    intended: Intended | None = None


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


@app.post("/games")
def create_game(body: NewGame):
    state = game.new_game(body.players)
    _save(state)
    return game.public(state)


@app.get("/games/{game_id}")
def get_game(game_id: str):
    return game.public(_load(game_id))


@app.post("/games/{game_id}/analyze")
async def analyze_in_game(game_id: str, photo: UploadFile = File(...)):
    """
    Like /analyze, but checked against the game's memory: only balls still in play can be
    detected, each keeps its identity between photos, and balls not seen are reported as
    `missing` for the player to confirm (never removed automatically).
    """
    state = _load(game_id)
    balls, not_balls = _vision(await _read_photo(photo))
    seen = game.reconcile(state, balls)
    _save(state)
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": seen["balls"],
        "missing": seen["missing"],
        "rejected": seen["rejected"] + not_balls,
        "game": game.public(state),
    }


@app.post("/games/{game_id}/shot")
def record_shot(game_id: str, body: ShotResult):
    """The current player took a shot: these balls went in (confirmed by the player)."""
    state = _load(game_id)
    try:
        event = game.apply_shot(state, body.pocketed, body.scratch,
                                body.intended and body.intended.model_dump())
    except game.GameError as e:
        raise HTTPException(409, str(e))
    try:
        store.save_shot(state, event)   # the game + the coach's long-term memory, together
    except store.StoreError as e:
        raise HTTPException(503, str(e))
    return game.public(state)


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
    _save(state)   # keeps the suggestion, so /shot knows what was coached
    return result


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

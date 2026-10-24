"""
Gemini as a second opinion on what each detected ball is.

The CV classifier guesses a ball's number from its median hue, which lighting easily
fools (orange vs yellow, maroon vs red, a stripe with its band turned down). So we crop
every detection out of the top-down warp, tile the crops into one labeled image, and ask
Gemini (one call per photo) what each tile is. Where Gemini is confident it wins; it can
also throw out detections that aren't balls at all (chalk, paper, a hand, a pocket).

Positions always come from CV: Gemini only says WHAT each ball is, never where.
Off unless GEMINI_BALL_ID=on (it adds seconds per photo). With no key, or if the call
fails, the CV answers are used unchanged.
"""
import json
import logging
import os
import string

import cv2
import numpy as np

from coach import gemini_client, gemini_key, model_name
from vision import BALL_RADIUS, DETECT_SCALE

log = logging.getLogger("cueiq.ball_id")

TILE = 160            # px per crop in the sheet sent to Gemini
COLS = 6
MIN_CONFIDENCE = 0.6  # below this, keep the CV answer
LABELS = string.ascii_uppercase

PROMPT = """Each tile is one object detected on a pool table, seen from above, labeled with a
letter. For every tile, say what it is.
Ball colors: 1 yellow, 2 blue, 3 red, 4 purple, 5 orange, 6 green, 7 maroon (dark red),
8 black. 9-15 are the same colors as 1-7 but white with a colored band (stripes):
9 yellow, 10 blue, 11 red, 12 purple, 13 orange, 14 green, 15 maroon. The cue ball is plain white.
If it isn't a pool ball (chalk, paper, tape, a hand, a pocket, glare), say not_a_ball.
Give number null if you can't tell which number it is. confidence is 0 to 1."""

SCHEMA = {
    "type": "object",
    "properties": {
        "balls": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "kind": {"type": "string", "enum": ["cue", "eight", "solid", "stripe", "not_a_ball"]},
                    "number": {"type": ["integer", "null"]},
                    "confidence": {"type": "number"},
                },
                "required": ["label", "kind", "number", "confidence"],
            },
        },
    },
    "required": ["balls"],
}


def contact_sheet(warped: np.ndarray, balls: list[dict]) -> bytes:
    """One JPEG with a labeled crop of each detection (up to 26)."""
    half = BALL_RADIUS * DETECT_SCALE * 2          # crop 2 ball-diameters wide: some context
    tiles = []
    for label, b in zip(LABELS, balls):
        crop = cv2.getRectSubPix(warped, (2 * half, 2 * half),
                                 (b["x"] * DETECT_SCALE, b["y"] * DETECT_SCALE))
        tile = cv2.resize(crop, (TILE, TILE), interpolation=cv2.INTER_CUBIC)
        tile = cv2.copyMakeBorder(tile, 36, 4, 4, 4, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        cv2.putText(tile, label, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
        tiles.append(tile)
    while len(tiles) % COLS:
        tiles.append(np.full_like(tiles[0], 255))
    rows = [np.hstack(tiles[i:i + COLS]) for i in range(0, len(tiles), COLS)]
    return cv2.imencode(".jpg", np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()


def _valid(kind: str, number: int | None) -> bool:
    if number is None:
        return True
    return (kind == "solid" and 1 <= number <= 7) or (kind == "stripe" and 9 <= number <= 15) \
        or (kind == "eight" and number == 8)


def apply(balls: list[dict], answers: list[dict]) -> tuple[list[dict], list[dict]]:
    """Merge Gemini's answers into the CV detections. Returns (kept, thrown out)."""
    by_label = {a["label"].strip().upper(): a for a in answers}
    kept, dropped = [], []
    for label, b in zip(LABELS, balls):
        a = by_label.get(label)
        if a is None or a["confidence"] < MIN_CONFIDENCE or not _valid(a["kind"], a["number"]):
            kept.append(b)
            continue
        if a["kind"] == "not_a_ball":
            dropped.append(b)
            continue
        if a["kind"] == "cue":
            number = None
        elif a["kind"] == "eight":
            number = 8
        elif a["number"] is not None:
            number = a["number"]
        elif a["kind"] == b["type"]:
            number = b["id"]   # same type, Gemini couldn't read the number: keep CV's guess
        else:
            number = None
        agrees = a["kind"] == b["type"] and number == b["id"]
        kept.append({
            **b, "type": a["kind"], "id": number,
            # Two independent methods agreeing is stronger than either alone.
            "confidence": round(max(b["confidence"], a["confidence"]) if agrees else a["confidence"], 2),
        })
    kept.extend(balls[len(LABELS):])   # more than 26 detections: rest stay CV-only
    return kept, dropped


def identify(warped: np.ndarray, balls: list[dict]) -> tuple[list[dict], list[dict]]:
    """Second opinion on every detection. Returns (balls, thrown out as not-a-ball)."""
    if not balls or gemini_key() is None or os.getenv("GEMINI_BALL_ID", "off") != "on":
        return balls, []
    try:
        from google.genai import types

        resp = gemini_client().models.generate_content(
            model=model_name(),
            contents=[types.Part.from_bytes(data=contact_sheet(warped, balls), mime_type="image/jpeg"),
                      PROMPT],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_json_schema=SCHEMA),
        )
        return apply(balls, json.loads(resp.text or "{}").get("balls", []))
    except Exception as e:   # best effort: never fail the photo because of the second opinion
        log.warning("Gemini ball ID failed, using CV only: %s", e)
        return balls, []

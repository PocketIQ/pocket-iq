"""
CueIQ backend - round-trip starter.

Right now /analyze ignores the photo's contents and returns fake balls.
That's on purpose: this proves upload, CORS, and the JSON contract work.
Person A replaces fake_balls() with the real vision pipeline (vision.py).
"""
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
load_dotenv

# Fixed table coordinate system shared by everyone (see CONTRACT.md).
TABLE_W, TABLE_H = 1000, 500
BALL_RADIUS = 11

app = FastAPI(title="CueIQ API")

# The browser blocks calls to a different domain unless the server allows it.
# Locally the frontend runs on :5173; in production add your Vercel URL
# via the FRONTEND_ORIGINS env var (comma-separated).
origins = os.getenv("FRONTEND_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins],
    allow_methods=["*"],
    allow_headers=["*"],
)


def fake_balls():
    """Placeholder until vision.py exists. Shapes match CONTRACT.md exactly."""
    return [
        {"id": None, "type": "cue",   "x": 250, "y": 250, "confidence": 0.99},
        {"id": 8,    "type": "eight", "x": 700, "y": 250, "confidence": 0.95},
        {"id": 1,    "type": "solid", "x": 640, "y": 220, "confidence": 0.90},
        {"id": 3,    "type": "solid", "x": 820, "y": 110, "confidence": 0.70},
        {"id": 6,    "type": "solid", "x": 480, "y": 400, "confidence": 0.85},
        {"id": 10,   "type": "stripe", "x": 760, "y": 300, "confidence": 0.60},
        {"id": 12,   "type": "stripe", "x": 900, "y": 420, "confidence": 0.80},
        {"id": 15,   "type": "stripe", "x": 380, "y": 90,  "confidence": 0.75},
    ]


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/analyze")
async def analyze(photo: UploadFile = File(...)):
    data = await photo.read()
    if not data:
        raise HTTPException(400, "Photo is empty.")

    # Decode to prove OpenCV can read what the phone sent.
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Couldn't read that file as an image. Send a JPEG or PNG.")

    h, w = img.shape[:2]
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": fake_balls(),
        "debug": {"received_bytes": len(data), "image_size": [w, h]},
    }

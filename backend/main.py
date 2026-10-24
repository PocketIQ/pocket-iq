"""CueIQ backend. POST /analyze: photo in, balls JSON out (see CONTRACT.md)."""
import os

from dotenv import load_dotenv

load_dotenv()  # reads backend/.env into os.environ

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from vision import BALL_RADIUS, TABLE_H, TABLE_W, VisionError, analyze_image  # noqa: E402

app = FastAPI(title="CueIQ API")

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


@app.post("/analyze")
async def analyze(photo: UploadFile = File(...)):
    data = await photo.read()
    if not data:
        raise HTTPException(400, "Photo is empty.")

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Couldn't read that file as an image. Send a JPEG or PNG.")

    try:
        result = analyze_image(img)
    except VisionError as e:
        # 422 = "I understood the request but can't use this photo". Frontend shows the message.
        raise HTTPException(422, str(e))

    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": result.balls,
    }

"""
CueIQ backend — upload a table photo, detect corner markers, return balls in table space.
"""
import os

import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from vision import BALL_RADIUS, TABLE_H, TABLE_W, VisionError, analyze_image

load_dotenv()

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
        raise HTTPException(400, str(e)) from e

    h, w = img.shape[:2]
    return {
        "table": {"width": TABLE_W, "height": TABLE_H},
        "ball_radius": BALL_RADIUS,
        "balls": result.balls,
        "debug": {
            "received_bytes": len(data),
            "image_size": [w, h],
            "markers_used": result.markers_used,
            "markers_rejected": result.markers_rejected,
        },
    }

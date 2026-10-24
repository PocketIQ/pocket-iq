# CueIQ data contract

Both sides code against this. Change it only together, and update
`frontend/src/types.ts` in the same commit.

## Coordinate system
- Table is always **1000 × 500** units (2:1, like a real table).
- Origin (0,0) = top-left corner of the **felt** (inside the cushions).
- x grows right, y grows down. Ball radius = 11 units.
- Vision warps every photo into this space. Physics and drawing only ever use it.

## POST /analyze
Request: `multipart/form-data`, field `photo` = JPEG/PNG.

Response:
```json
{
  "table": {"width": 1000, "height": 500},
  "ball_radius": 11,
  "balls": [
    {"id": null, "type": "cue",    "x": 250, "y": 250, "confidence": 0.99},
    {"id": 8,    "type": "eight",  "x": 700, "y": 250, "confidence": 0.95},
    {"id": 10,   "type": "stripe", "x": 760, "y": 300, "confidence": 0.60}
  ]
}
```
- `type`: `"cue" | "eight" | "solid" | "stripe"`
- `id`: 1–15, or `null` for the cue ball / when the number isn't readable
- `confidence` < 0.7 → frontend flags the ball for the user to confirm

Errors: HTTP 400 with `{"detail": "human-readable message"}`.

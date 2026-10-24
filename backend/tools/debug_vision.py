"""
See what the vision pipeline sees.
    python tools/debug_vision.py path/to/photo.jpg
Writes debug_<name>.jpg: the top-down warp with every detected ball circled and labeled.
Green = confident, yellow = unsure. If the warp looks skewed, MARKER_OFFSET or marker
placement is wrong. If balls are missed or ghosts appear, tune find_circles().
"""
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vision import DETECT_SCALE, BALL_RADIUS, VisionError, analyze_image  # noqa: E402

for p in sys.argv[1:]:
    img = cv2.imread(p)
    if img is None:
        print(f"{p}: can't read"); continue
    try:
        res = analyze_image(img)
    except VisionError as e:
        print(f"{p}: {e}"); continue
    out = res.warped.copy()
    for b in res.balls:
        c = (int(b["x"] * DETECT_SCALE), int(b["y"] * DETECT_SCALE))
        color = (0, 220, 0) if b["confidence"] >= 0.7 else (0, 220, 255)
        cv2.circle(out, c, BALL_RADIUS * DETECT_SCALE + 4, color, 3)
        label = f"{b['type']} {b['id'] or ''} {b['confidence']:.2f}"
        cv2.putText(out, label, (c[0] - 40, c[1] - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    name = f"debug_{Path(p).stem}.jpg"
    cv2.imwrite(name, out)
    print(f"{p}: {len(res.balls)} balls, markers used {res.markers_used}"
          + (f", REJECTED {res.markers_rejected} (misplaced?)" if res.markers_rejected else "")
          + f" -> {name}")
    for b in res.balls:
        print("   ", b)

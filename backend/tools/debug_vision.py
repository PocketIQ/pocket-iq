"""
See what the vision pipeline sees.
    python tools/debug_vision.py path/to/photo.jpg [more.jpg ...]

For each photo writes three images:
  debug_felt_<name>.jpg     the photo with the felt outline fit (the default way to warp):
        cyan tint       = pixels counted as felt
        colored dots    = outline points each edge's line was fitted to
                          (red = top, yellow = right, magenta = bottom, blue = left)
        green lines     = fitted edges; TL/TR/BR/BL = table corners they map to
        gap numbers     = how much felt is missing at each edge's middle; the two long
                          edges should be clearly bigger (side pockets)
  debug_markers_<name>.jpg  the ORIGINAL photo (markers are only a fallback):
        green box + ID  = marker found and read on the first pass
        cyan box + ID   = marker recovered by a later pass (contrast boost, board
                          prediction, or upscaled crop; see vision.find_markers)
        red outline     = something marker-shaped was found but couldn't be read
                          (too small, blurry, glare, or too steep an angle)
        nothing at all  = the detector never even saw it (too small, or too low contrast)
  debug_<name>.jpg          the top-down warp with every ball circled
        green = confident, yellow = unsure
"""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vision import (BALL_RADIUS, DETECT_SCALE, MARKERS, VisionError, analyze_image,  # noqa: E402
                    detect_raw, find_felt, find_markers)

EDGE_COLORS = [(0, 0, 255), (0, 255, 255), (255, 0, 255), (255, 128, 0)]  # top right bottom left


def felt_view(img, fit):
    s = fit.scale
    v = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    tint = v.copy()
    tint[fit.mask > 0] = (255, 255, 0)
    v = cv2.addWeighted(v, 0.75, tint, 0.25, 0)
    t = max(2, v.shape[1] // 800)
    for i, pts in enumerate(fit.sides):
        for q in pts[::2].astype(int):
            cv2.circle(v, tuple(q), t, EDGE_COLORS[i], -1)
    c = fit.corners * s
    for i in range(4):
        a, b = c[i], c[(i + 1) % 4]
        cv2.line(v, tuple(a.astype(int)), tuple(b.astype(int)), (0, 255, 0), t)
        cv2.putText(v, ["TL", "TR", "BR", "BL"][i], tuple(a.astype(int) + [10, -10]),
                    cv2.FONT_HERSHEY_SIMPLEX, t * 0.6, (0, 255, 0), t)
        mid = ((a + b) / 2).astype(int)
        cv2.putText(v, f"gap {fit.pocket_gaps[i]:.3f}", tuple(mid + [10, 30]),
                    cv2.FONT_HERSHEY_SIMPLEX, t * 0.45, EDGE_COLORS[i], t)
    return v

for p in sys.argv[1:]:
    img = cv2.imread(p)
    if img is None:
        print(f"{p}: can't read"); continue
    stem = Path(p).stem

    print(f"{p}: {img.shape[1]}x{img.shape[0]}px")

    # --- felt view
    try:
        fit = find_felt(img)
        cv2.imwrite(f"debug_felt_{stem}.jpg", felt_view(img, fit))
        print(f"   felt: found -> debug_felt_{stem}.jpg   pocket gaps (top right bottom left): "
              f"{[round(g, 3) for g in fit.pocket_gaps]}")
    except VisionError as e:
        print(f"   felt: {e}")

    # --- marker view on the original photo
    corners, ids, rejected = detect_raw(img)
    view = img.copy()
    t = max(2, img.shape[1] // 800)  # line thickness that scales with photo size
    # The detector rejects lots of tiny junk shapes. Only show candidates that look like a
    # real failed marker: big enough, and with both black and white inside.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    shown = 0
    for quad in rejected:
        q = quad.reshape(-1, 2).astype(np.int32)
        x, y, w, h = cv2.boundingRect(q)
        if w < 10 or h < 6:
            continue
        inside = gray[y:y + h, x:x + w]
        if inside.size == 0 or inside.std() < 40:
            continue
        cv2.polylines(view, [q], True, (0, 0, 255), t)
        shown += 1
    found = []
    if ids is not None:
        for quad, mid in zip(corners, ids.flatten()):
            q = quad.astype(np.int32)
            cv2.polylines(view, [q], True, (0, 255, 0), t * 2)
            side = float(np.linalg.norm(quad[0][0] - quad[0][1]))
            cv2.putText(view, f"#{mid} {side:.0f}px", tuple(q[0][0] + [0, -10]),
                        cv2.FONT_HERSHEY_SIMPLEX, t * 0.5, (0, 255, 0), t)
            found.append((int(mid), round(side)))
    recovered = []
    for mid, quad in find_markers(img).items():
        if mid in dict(found):
            continue
        q = quad.astype(np.int32)
        cv2.polylines(view, [q], True, (255, 255, 0), t * 2)
        cv2.putText(view, f"#{mid}", tuple(q[0] + [0, -10]),
                    cv2.FONT_HERSHEY_SIMPLEX, t * 0.5, (255, 255, 0), t)
        recovered.append(mid)
    cv2.imwrite(f"debug_markers_{stem}.jpg", view)
    missing = [MARKERS[i][0] for i in MARKERS if i not in dict(found) and i not in recovered]
    print(f"   markers read (id, width px): {sorted(found)}   recovered by later passes: {sorted(recovered)}")
    print(f"   marker-like shapes it couldn't read: {shown}   missing: {missing or 'none'}")

    # --- ball view on the warp
    try:
        res = analyze_image(img)
    except VisionError as e:
        print(f"   {e}"); continue
    out = res.warped.copy()
    for b in res.balls:
        c = (int(b["x"] * DETECT_SCALE), int(b["y"] * DETECT_SCALE))
        color = (0, 220, 0) if b["confidence"] >= 0.7 else (0, 220, 255)
        cv2.circle(out, c, BALL_RADIUS * DETECT_SCALE + 4, color, 3)
        cv2.putText(out, f"{b['type']} {b['id'] or ''} {b['confidence']:.2f}", (c[0] - 40, c[1] - 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    cv2.imwrite(f"debug_{stem}.jpg", out)
    print(f"   warped using {res.method}; {len(res.balls)} balls -> debug_{stem}.jpg")

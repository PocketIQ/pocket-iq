"""
CueIQ vision pipeline:  photo -> find ArUco markers (4+) -> warp to top-down -> find balls -> classify.

Every number you'll want to tune is in the CONFIG block. Run tools/debug_vision.py on
real photos to see what each stage produces before touching anything else.
"""
from dataclasses import dataclass

import cv2
import numpy as np

# ------------------------------------------------------------------ CONFIG
TABLE_W, TABLE_H = 1000, 500          # table coordinate system (CONTRACT.md)
BALL_RADIUS = 11                      # in table units

# Distance from each marker's CENTER to the felt edge, in table units, along each axis.
# On a 7ft table (playing area ~78in long) 1 unit ≈ 0.078in, so a marker centered
# ~2.5in outside the felt ≈ 32 units. MEASURE YOUR TABLE.
MARKER_OFFSET = 32
_m, _W, _H = MARKER_OFFSET, TABLE_W, TABLE_H

# Marker ID -> (name, where its center sits in table coordinates).
# One marker behind each of the 6 pockets. Corner markers sit diagonally behind the
# pocket; side markers sit straight back from the side pocket. Add or remove entries
# freely: the warp uses whatever markers it finds, as long as there are at least 4.
MARKERS = {
    0: ("top left", (-_m, -_m)),
    1: ("top right", (_W + _m, -_m)),
    2: ("bottom right", (_W + _m, _H + _m)),
    3: ("bottom left", (-_m, _H + _m)),
    4: ("top side", (_W / 2, -_m)),
    5: ("bottom side", (_W / 2, _H + _m)),
}
MIN_MARKERS = 4
# After fitting, if any marker lands more than this many table units from its spot,
# the photo is rejected as "markers misplaced". ~10 units ≈ 0.8in on a 7ft table.
MAX_MARKER_ERROR = 10

# Detection runs on an upscaled warp for precision; coordinates are scaled back down.
DETECT_SCALE = 2
ARUCO_DICT = cv2.aruco.DICT_4X4_50
# --------------------------------------------------------------------------


class VisionError(Exception):
    """Something the user can fix by retaking the photo. Message is shown to them."""


@dataclass
class VisionResult:
    balls: list[dict]
    warped: np.ndarray            # top-down image at DETECT_SCALE, handy for debugging
    markers_used: list[int]       # IDs found and trusted
    markers_rejected: list[int]   # IDs found but ignored as misplaced


_params = cv2.aruco.DetectorParameters()
# Sub-pixel corner refinement: locates marker corners between pixels. Matters more the
# smaller the markers are, since each pixel of error is a bigger share of the marker.
_params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
_detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(ARUCO_DICT), _params)


# ---------------------------------------------------------------- 1. markers
def find_markers(img: np.ndarray) -> dict[int, np.ndarray]:
    """Return {marker_id: (x, y) center in photo pixels} for every known marker found."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = _detector.detectMarkers(gray)
    found = {}
    if ids is not None:
        for quad, mid in zip(corners, ids.flatten()):
            if int(mid) in MARKERS:
                found[int(mid)] = quad[0].mean(axis=0)  # center = average of its 4 corners
    return found


# ------------------------------------------------------------------- 2. warp
def _fit(markers: dict[int, np.ndarray], ids: list[int]) -> tuple[np.ndarray, float]:
    """Least-squares homography from these markers, plus the worst marker's error (table units)."""
    src = np.float32([markers[i] for i in ids])
    dst = np.float32([MARKERS[i][1] for i in ids])
    H, _ = cv2.findHomography(src, dst, 0)  # 0 = plain least squares over all points
    if H is None:
        return None, float("inf")
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    return H, float(np.linalg.norm(projected - dst, axis=1).max())


def compute_homography(markers: dict[int, np.ndarray]) -> tuple[np.ndarray, list[int]]:
    """
    A homography is a 3x3 matrix that maps points on one flat plane (the table in the
    photo) onto another (the top-down table). 4 point pairs pin it down exactly.

    With MORE than 4 pairs, no single matrix fits them all perfectly (tape is never
    placed perfectly), so we take the least-squares best fit. That averages out small
    placement errors instead of trusting any one marker completely.

    Sanity check: after fitting, if some marker still lands far from its spot, the setup
    is wrong (marker bumped or taped in the wrong place). We refuse rather than guess,
    because with only ~6 markers we can't reliably tell WHICH one is wrong.
    Returns the matrix and a list of marker IDs that were rejected (always empty now;
    kept so callers don't change if you add smarter rejection later).
    """
    ids = sorted(markers)
    src = np.float32([markers[i] for i in ids])
    dst = np.float32([MARKERS[i][1] for i in ids])
    if len(ids) == 4:
        try:
            return cv2.getPerspectiveTransform(src, dst), []  # exact fit, nothing to check
        except cv2.error as e:
            raise VisionError(
                "Couldn't lock onto the table from those four markers. "
                "Make sure they are flat, fully in frame, and in the labeled corners."
            ) from e

    H, worst = _fit(markers, ids)
    if H is None or worst > MAX_MARKER_ERROR:
        raise VisionError(
            "The markers don't line up with each other. One may have been moved: "
            "check they're all flat and in their spots, then retake."
        )
    return H, []


def warp_to_table(img: np.ndarray, H: np.ndarray) -> np.ndarray:
    s = DETECT_SCALE
    scale = np.diag([s, s, 1.0])  # table units -> detection pixels
    return cv2.warpPerspective(img, scale @ H, (TABLE_W * s, TABLE_H * s))


# ------------------------------------------------------------------ 3. balls
def find_circles(warped: np.ndarray) -> np.ndarray:
    """
    Plain grayscale fails on dark balls (blue/green/maroon look like felt in gray).
    Instead build a "how different from the felt is this pixel" image: felt goes black,
    every ball, whatever its color, goes bright. Then look for circles in that.
    """
    r = BALL_RADIUS * DETECT_SCALE
    lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB).astype(np.float32)
    felt = np.median(lab.reshape(-1, 3), axis=0)          # felt is most of the image
    diff = np.linalg.norm(lab - felt, axis=2)
    diff = cv2.normalize(diff, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    diff = cv2.GaussianBlur(diff, (5, 5), 1.5)
    circles = cv2.HoughCircles(
        diff, cv2.HOUGH_GRADIENT, dp=1.2,
        minDist=r * 1.6,          # two ball centers can't be closer than ~2 radii
        param1=100,               # edge strength (Canny high threshold)
        param2=18,                # lower = more circles found (and more false ones)
        minRadius=int(r * 0.75), maxRadius=int(r * 1.3),
    )
    return np.empty((0, 3)) if circles is None else circles[0]


def is_felt(hsv_patch: np.ndarray, felt_hue: float) -> bool:
    """True if a patch is mostly felt-colored (catches false circles in the cloth)."""
    h, s = hsv_patch[..., 0].astype(float), hsv_patch[..., 1]
    close = (np.abs(h - felt_hue) < 10) & (s > 60)
    return close.mean() > 0.6


# Approximate OpenCV hues (0-180) -> ball number 1-7. Stripes add 8.
# Lighting shifts these a lot; it's a best guess, the Correction UI fixes it.
def guess_number(hue: float, val: float) -> int:
    if hue < 8 or hue > 170:
        return 7 if val < 120 else 3     # maroon vs red
    if hue < 18: return 5                # orange
    if hue < 35: return 1                # yellow
    if hue < 90: return 6                # green
    if hue < 130: return 2               # blue
    return 4                             # purple


def classify(hsv: np.ndarray, x: float, y: float, r: float) -> dict:
    """
    Look only at pixels inside the ball. Count how many are white (cue / stripe band),
    black (8-ball), or colored. The ratios decide the type.
    """
    mask = np.zeros(hsv.shape[:2], np.uint8)
    cv2.circle(mask, (int(x), int(y)), int(r * 0.85), 255, -1)
    px = hsv[mask > 0]
    h, s, v = px[:, 0].astype(float), px[:, 1], px[:, 2]

    white = ((s < 60) & (v > 170)).mean()
    black = (v < 60).mean()
    colored = ~((s < 60) & (v > 170)) & (v >= 60)

    if white > 0.75:
        return {"type": "cue", "id": None, "confidence": round(float(min(1.0, white)), 2)}
    if black > 0.55:
        return {"type": "eight", "id": 8, "confidence": round(float(min(1.0, black)), 2)}

    hue = float(np.median(h[colored])) if colored.any() else 0.0
    val = float(np.median(v[colored])) if colored.any() else 0.0
    n = guess_number(hue, val)
    # Stripe: a solid color band on a white ball, so lots of white but not mostly white.
    # Thresholds are a starting point: tune them with tools/debug_vision.py on real photos.
    if white > 0.2:
        conf = 1 - abs(white - 0.45) * 2.5    # most sure around 45% white
        return {"type": "stripe", "id": n + 8, "confidence": round(float(max(0.3, conf)), 2)}
    conf = 1 - white / 0.2                    # most sure at 0% white
    return {"type": "solid", "id": n, "confidence": round(float(max(0.3, conf)), 2)}


# ------------------------------------------------------------------ pipeline
def analyze_image(img: np.ndarray) -> VisionResult:
    markers = find_markers(img)
    if len(markers) < MIN_MARKERS:
        missing = [MARKERS[i][0] for i in MARKERS if i not in markers]
        raise VisionError(
            f"Found {len(markers)} of {len(MARKERS)} markers (need at least {MIN_MARKERS}). "
            f"Missing: {', '.join(missing)}. Step back so more of them are in frame."
        )

    H, rejected = compute_homography(markers)
    warped = warp_to_table(img, H)
    hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)
    felt_hue = float(np.median(hsv[..., 0]))   # the felt is most of the image

    r = BALL_RADIUS * DETECT_SCALE
    balls = []
    for x, y, rad in find_circles(warped):
        y0, y1, x0, x1 = int(y - r / 2), int(y + r / 2), int(x - r / 2), int(x + r / 2)
        patch = hsv[max(0, y0):y1, max(0, x0):x1]
        if patch.size == 0 or is_felt(patch, felt_hue):
            continue
        info = classify(hsv, x, y, rad)
        balls.append({
            **info,
            "x": round(float(x) / DETECT_SCALE, 1),
            "y": round(float(y) / DETECT_SCALE, 1),
        })

    # Only one cue ball and one 8-ball can exist: keep the most confident of each.
    for t in ("cue", "eight"):
        same = sorted([b for b in balls if b["type"] == t], key=lambda b: -b["confidence"])
        for extra in same[1:]:
            extra["type"], extra["confidence"] = "solid", 0.3  # flag for user correction

    used = [i for i in sorted(markers) if i not in rejected]
    return VisionResult(balls=balls, warped=warped, markers_used=used, markers_rejected=rejected)

"""
CueIQ vision pipeline:  photo -> find the felt's outline (or, failing that, ArUco markers)
-> warp to top-down -> find balls -> classify.

Every number you'll want to tune is in the CONFIG block. Run tools/debug_vision.py on
real photos to see what each stage produces before touching anything else.
"""
from dataclasses import dataclass
from itertools import combinations

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
# freely: the warp uses whatever markers it finds (see MIN_MARKERS / MIN_SPREAD).
MARKERS = {
    0: ("top left", (-_m, -_m)),
    1: ("top right", (_W + _m, -_m)),
    2: ("bottom right", (_W + _m, _H + _m)),
    3: ("bottom left", (-_m, _H + _m)),
    4: ("top side", (_W / 2, -_m)),
    5: ("bottom side", (_W / 2, _H + _m)),
}

# Printed width of each marker's black square. Bigger far-side markers are fine (and
# help a lot for low-angle photos): set their size here and print with make_markers.py.
# Playing area of a 7ft table is ~198cm long, so 1cm ≈ 5 table units.
TABLE_LENGTH_CM = 198
MARKER_SIZE_CM = {mid: 5.0 for mid in MARKERS}

# Every marker is taped with its printed arrow pointing straight across the table,
# toward the felt (perpendicular to the long rails). The warp uses all 4 corners of
# each marker, so the orientation matters: a marker taped rotated won't line up.

# 2 markers give 8 corner points, enough for the warp, as long as they're spread out:
# their centers must span at least this fraction of the table in BOTH x and y.
# (Two markers on the same rail can't tell how the table tilts the other way.)
MIN_MARKERS = 2
MIN_SPREAD = 0.5
# After fitting, if any marker corner lands more than this many table units from its
# spot, the photo is rejected as "markers misplaced". ~10 units ≈ 0.8in on a 7ft table.
MAX_MARKER_ERROR = 10

# Felt outline (the default; markers are only a fallback). The felt region's outer edge
# is where the cushion tops meet the rail, CUSHION_WIDTH table units outside the playing
# area. On a 9ft table 1 unit = 0.1in, so a 2in cushion top = 20 units. Checked on the
# test photos: the fitted outline's true aspect ratio (from the lens focal length) came
# out 1.92-1.93 in all five, i.e. (1000 + 2*C) / (500 + 2*C) with C = 18-21.
CUSHION_WIDTH = 20
FELT_WORK_SIDE = 2000      # the felt mask is built on a copy this many px on its long side
FELT_CHROMA_TOL = 18       # max color distance (LAB a/b) from the felt to count as felt
FELT_MIN_CHROMA = 8        # the photo's middle must be at least this colorful to be cloth

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
    method: str = "felt"          # what the warp came from: "felt" or "markers"


def _detector_params(**overrides) -> cv2.aruco.DetectorParameters:
    p = cv2.aruco.DetectorParameters()
    # Sub-pixel corner refinement: locates marker corners between pixels. Matters more the
    # smaller the markers are, since each pixel of error is a bigger share of the marker.
    p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    # Tuned for small, far-away markers (defaults are built for big, close ones):
    # - Default rejects any marker whose outline is under 3% of the image's longest side.
    #   In a 3000px photo that throws away every marker under ~22px wide BEFORE trying to
    #   read it, which is exactly the far markers. 0.5% keeps them.
    p.minMarkerPerimeterRate = 0.005
    p.minCornerDistanceRate = 0.02
    # Try smaller thresholding windows, so a tiny marker isn't averaged into the felt.
    p.adaptiveThreshWinSizeMin = 3
    p.adaptiveThreshWinSizeMax = 53
    p.adaptiveThreshWinSizeStep = 4
    # Far markers are seen at a steep angle, so their outline is a squashed, slightly
    # blurry quadrilateral. Be more forgiving when matching the outline to a 4-sided shape.
    p.polygonalApproxAccuracyRate = 0.05
    # Sample each cell of the marker with more pixels when reading its bits.
    p.perspectiveRemovePixelPerCell = 8
    p.perspectiveRemoveIgnoredMarginPerCell = 0.2
    for k, v in overrides.items():
        setattr(p, k, v)
    return p


_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
_detector = cv2.aruco.ArucoDetector(_dict, _detector_params())
# Second-chance reader, only ever run on a small crop where a specific marker is
# expected. Because we already know which ID should be there and where, it can afford
# to accept more misread bits than a whole-photo search could.
# errorCorrectionRate multiplies the dictionary's own budget, which is 1 bit for 4x4_50,
# so the default 0.6 rounds down to 0 corrected bits. 2.0 allows 2 bits out of 16.
_lenient = cv2.aruco.ArucoDetector(_dict, _detector_params(
    errorCorrectionRate=2.0,
    maxErroneousBitsInBorderRate=0.5,      # default 0.35
))
# Contrast boost for pass 2: lifts dim or glare-washed markers out of the background.
_clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))


# ---------------------------------------------------------------- 1. markers
def marker_corners(mid: int) -> np.ndarray:
    """
    Where marker `mid`'s 4 corners sit in table coordinates, in ArUco's corner order:
    top-left, top-right, bottom-right, bottom-left of the PRINTED marker, where "top" is
    the side its arrow points to. Arrows point across the table toward the felt.
    """
    cx, cy = MARKERS[mid][1]
    half = MARKER_SIZE_CM[mid] * TABLE_W / TABLE_LENGTH_CM / 2
    up = np.array([0.0, 1.0 if cy < TABLE_H / 2 else -1.0])   # table y grows down
    right = np.array([-up[1], up[0]])                          # viewed from above
    center = np.array([cx, cy])
    return np.float32([center + half * (dx * right - dy * up)
                       for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])


# The marker layout as an ArUco "board", so OpenCV can predict where missing markers
# should be from the ones it found (see find_markers, pass 3).
_board = cv2.aruco.Board(
    [np.hstack([marker_corners(i), np.zeros((4, 1), np.float32)]) for i in MARKERS],
    _dict, np.array(list(MARKERS), np.int32),
)


def detect_raw(img: np.ndarray):
    """Raw first-pass ArUco output: (corners, ids, rejected candidates). Used by the debug tool."""
    return _detector.detectMarkers(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))


def _known(corners, ids) -> dict[int, np.ndarray]:
    """Keep detections whose ID is one of ours, as {id: 4x2 corners}."""
    if ids is None:
        return {}
    return {int(m): q.reshape(4, 2) for q, m in zip(corners, ids.flatten()) if int(m) in MARKERS}


def find_markers(img: np.ndarray) -> dict[int, np.ndarray]:
    """
    Return {marker_id: 4x2 corners in photo pixels} for every known marker found.
    Cheapest pass first; later passes only run while markers are still missing.
      1. normal detection on the photo
      2. same, on a contrast-boosted copy
      3. board refinement: predict where missing markers should be from the found ones,
         and re-check the "marker-shaped but unreadable" candidates near those spots
      4. crop around each still-missing marker's predicted spot, upscale, read leniently
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners, ids, rejected = _detector.detectMarkers(gray)
    found = _known(corners, ids)
    rejected = list(rejected)

    if len(found) < len(MARKERS):                                  # pass 2
        c2, i2, r2 = _detector.detectMarkers(_clahe.apply(gray))
        for mid, q in _known(c2, i2).items():
            found.setdefault(mid, q)
        rejected += list(r2)

    if found and len(found) < len(MARKERS):                        # pass 3
        # How far (px) a candidate may sit from its predicted spot. Tape is never placed
        # perfectly and the prediction extrapolates, so scale with photo size.
        refine = cv2.aruco.RefineParameters(
            minRepDistance=0.01 * max(gray.shape), errorCorrectionRate=3, checkAllOrders=True)
        det = cv2.aruco.ArucoDetector(_dict, _detector_params(), refine)
        mids = list(found)
        c3, i3, _, _ = det.refineDetectedMarkers(
            gray, _board, [found[m].reshape(1, 4, 2) for m in mids],
            np.array(mids, np.int32).reshape(-1, 1), rejected)
        for mid, q in _known(c3, i3).items():
            found.setdefault(mid, q)

    if _well_spread(found) and len(found) < len(MARKERS):          # pass 4
        H, _ = _fit(found)
        if H is not None:
            to_photo = np.linalg.inv(H)
            for mid in MARKERS:
                if mid not in found:
                    q = _read_crop(gray, mid, to_photo)
                    if q is not None:
                        found[mid] = q
    return found


def _read_crop(gray: np.ndarray, mid: int, to_photo: np.ndarray) -> np.ndarray | None:
    """Look for marker `mid` in an upscaled, contrast-boosted crop around where it should be."""
    pred = cv2.perspectiveTransform(marker_corners(mid).reshape(-1, 1, 2), to_photo).reshape(4, 2)
    x0, y0 = pred.min(axis=0)
    x1, y1 = pred.max(axis=0)
    w, h = x1 - x0, y1 - y0
    pad = max(w, h) + 10   # room for placement error and the marker's white border
    X0, Y0 = int(max(0, x0 - pad)), int(max(0, y0 - pad))
    X1, Y1 = int(min(gray.shape[1], x1 + pad)), int(min(gray.shape[0], y1 + pad))
    if X1 - X0 < 8 or Y1 - Y0 < 8:
        return None   # predicted off-photo
    # Upscale until the marker's squashed side is ~80px, so each of its 6 cells gets
    # enough pixels to threshold and read. Capped to keep the crop small.
    f = float(np.clip(80 / max(min(w, h), 1), 1, 6))
    crop = cv2.resize(_clahe.apply(gray[Y0:Y1, X0:X1]), None, fx=f, fy=f,
                      interpolation=cv2.INTER_CUBIC)
    corners, ids, _ = _lenient.detectMarkers(crop)
    if ids is None:
        return None
    for q, m in zip(corners, ids.flatten()):
        if int(m) != mid:
            continue
        q = q.reshape(4, 2) / f + [X0, Y0]
        # Lenient reading could misfire: only trust it right where the marker should be.
        if np.linalg.norm(q.mean(axis=0) - pred.mean(axis=0)) < max(w, h):
            return q.astype(np.float32)
    return None


# ------------------------------------------------------------------- 2. warp
def _well_spread(markers: dict) -> bool:
    """Enough markers, far enough apart in both directions, to pin down the warp."""
    if len(markers) < MIN_MARKERS:
        return False
    centers = np.array([MARKERS[i][1] for i in markers])
    span = centers.max(axis=0) - centers.min(axis=0)
    return span[0] >= MIN_SPREAD * TABLE_W and span[1] >= MIN_SPREAD * TABLE_H


def _fit(markers: dict[int, np.ndarray]) -> tuple[np.ndarray, float]:
    """Least-squares homography from every corner of these markers, plus the worst corner's error (table units)."""
    ids = sorted(markers)
    src = np.concatenate([markers[i] for i in ids]).astype(np.float32)
    dst = np.concatenate([marker_corners(i) for i in ids])
    H, _ = cv2.findHomography(src, dst, 0)  # 0 = plain least squares over all points
    if H is None:
        return None, float("inf")
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    return H, float(np.linalg.norm(projected - dst, axis=1).max())


def compute_homography(markers: dict[int, np.ndarray]) -> tuple[np.ndarray, list[int]]:
    """
    A homography is a 3x3 matrix that maps points on one flat plane (the table in the
    photo) onto another (the top-down table). 4 point pairs pin it down exactly.

    Each marker contributes all 4 of its corners, so even 2 markers give 8 pairs. No
    single matrix fits them all perfectly (tape is never placed perfectly), so we take
    the least-squares best fit. That averages out small placement errors instead of
    trusting any one marker completely.

    Sanity check: after fitting, if some corner still lands far from its spot, the setup
    is wrong (marker bumped, rotated, or taped in the wrong place). We refuse rather than
    guess, because with only ~6 markers we can't reliably tell WHICH one is wrong.
    Returns the matrix and a list of marker IDs that were rejected (always empty now;
    kept so callers don't change if you add smarter rejection later).
    """
    H, worst = _fit(markers)
    if H is None or worst > MAX_MARKER_ERROR:
        raise VisionError(
            "The markers don't line up with each other. One may have been moved: check "
            "they're all flat, in their spots, and with arrows pointing across the table "
            "toward the felt, then retake."
        )
    return H, []


def warp_to_table(img: np.ndarray, H: np.ndarray) -> np.ndarray:
    s = DETECT_SCALE
    scale = np.diag([s, s, 1.0])  # table units -> detection pixels
    return cv2.warpPerspective(img, scale @ H, (TABLE_W * s, TABLE_H * s))


# --------------------------------------------------------- 2b. felt outline
# No markers needed: the felt is the biggest, most distinctive thing in the photo, and
# its far edge stays a long sharp line even when the far markers are unreadable.
# The cushions are covered in the same cloth, so the felt-colored region ends where the
# cushion tops meet the rail. We fit a straight line to each of those 4 edges and warp
# their corners to the felt rectangle, which is CUSHION_WIDTH bigger than the playing area
# on every side. (Cushion tops are about ball-center height, so balls land in the right
# spot even from a low angle.)

@dataclass
class FeltFit:
    corners: np.ndarray        # 4x2 photo px: top-left, top-right, bottom-right, bottom-left
    mask: np.ndarray           # felt mask at work scale (debug)
    scale: float               # work px per photo px
    sides: list[np.ndarray]    # contour points used for each edge, work px (debug)
    pocket_gaps: list[float]   # how far in from each edge's midpoint the felt is missing (debug)


def _felt_mask(small: np.ndarray) -> np.ndarray:
    """Pixels whose color is close to the felt, sampled from the middle of the photo."""
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    felt = np.median(lab[h * 2 // 5:h * 3 // 5, w * 2 // 5:w * 3 // 5].reshape(-1, 3), axis=0)
    if np.linalg.norm(felt[1:] - 128) < FELT_MIN_CHROMA:
        raise VisionError("Couldn't find the table cloth in the middle of the photo. "
                          "Center the table in the shot.")
    # Compare color only (LAB a/b), not brightness, so lamp hotspots and shading still count.
    # Very dark pixels have no reliable color (pockets, black rails): keep those out.
    chroma = np.linalg.norm(lab[..., 1:] - felt[1:], axis=2)
    mask = ((chroma < FELT_CHROMA_TOL) & (lab[..., 0] > 0.35 * felt[0])).astype(np.uint8) * 255
    # Bridge the thin dark line where the cushion face meets the bed, and chalk marks.
    k = max(3, int(0.008 * max(h, w)) | 1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    # Keep only the biggest blob, with its holes (balls) filled.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise VisionError("Couldn't find the table cloth. Get the whole table in the shot.")
    out = np.zeros_like(mask)
    cv2.drawContours(out, [max(contours, key=cv2.contourArea)], -1, 255, -1)
    return out


def _rough_quad(contour: np.ndarray) -> np.ndarray:
    """
    The felt outline's 4 rough corners: the 4 points of its convex hull that enclose the
    most area. (Simplifying the hull with approxPolyDP can pick a corner mid-edge.) Only
    used to split the outline into its 4 edges; the real corners come from the line fits.
    """
    hull = cv2.convexHull(contour).reshape(-1, 2).astype(np.float64)
    if len(hull) > 60:   # keep the brute force below small; hulls here are ~20-50 points
        hull = cv2.approxPolyDP(hull.astype(np.float32), 2.0, True).reshape(-1, 2).astype(np.float64)
    if len(hull) < 4:
        raise VisionError("The table outline doesn't look like a rectangle. "
                          "Get all four rails in the shot, with nothing covering them.")
    # Every 4 hull points, in hull order, form a convex quad: shoelace area for each.
    idx = np.array(list(combinations(range(len(hull)), 4)))
    q = hull[idx]                                   # (n, 4, 2)
    x, y = q[..., 0], q[..., 1]
    area = np.abs((x * np.roll(y, -1, axis=1) - np.roll(x, -1, axis=1) * y).sum(axis=1))
    return q[area.argmax()]


def _fit_side(pts: np.ndarray, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Robust straight line through the outline points along edge a->b. Skips the ends,
    where the corner pockets bite into the felt, and ignores the side-pocket notch.
    Returns (point on line, unit direction).
    """
    d = (b - a) / np.linalg.norm(b - a)
    n = np.array([-d[1], d[0]])
    length = np.linalg.norm(b - a)
    t = (pts - a) @ d
    off = (pts - a) @ n
    # The rough corners can sit on a pocket's jaw tip, so a->b may be tilted off the real
    # edge by a few % of its length: search a wide band, then let RANSAC find the edge.
    near = (t > 0.12 * length) & (t < 0.88 * length) & (np.abs(off) < 0.12 * length)
    sel = pts[near]
    if len(sel) < 20:
        raise VisionError("Couldn't trace one of the table's edges. "
                          "Get the whole table in the shot, with nothing covering the rails.")
    rng = np.random.default_rng(0)
    pairs = rng.integers(0, len(sel), (300, 2))
    best, best_count = None, 0
    for i, j in pairs:
        v = sel[j] - sel[i]
        if np.linalg.norm(v) < 0.2 * length:
            continue
        nv = np.array([-v[1], v[0]]) / np.linalg.norm(v)
        count = (np.abs((sel - sel[i]) @ nv) < 2.0).sum()
        if count > best_count:
            best, best_count = (sel[i], nv), count
    if best is None or best_count < 20:
        raise VisionError("Couldn't trace one of the table's edges. "
                          "Get the whole table in the shot, with nothing covering the rails.")
    sel = sel[np.abs((sel - best[0]) @ best[1]) < 3.0]
    vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return np.array([x0, y0], float), np.array([vx, vy], float)


def _intersect(p1, d1, p2, d2) -> np.ndarray:
    A = np.array([d1, -d2]).T
    s, _ = np.linalg.solve(A, p2 - p1)
    return p1 + s * d1


def _pocket_gaps(mask: np.ndarray, corners: np.ndarray) -> list[float]:
    """
    For each edge corners[i] -> corners[i+1]: starting at the edge's true midpoint (the
    perspective-correct one), how far inward is there no felt? A side pocket cuts through
    the whole cushion there; a short edge has felt right up to the rail. Measured as a
    fraction of the table's other dimension, median of a few rays near the midpoint.
    """
    to_img = cv2.getPerspectiveTransform(np.float32([[0, 0], [1, 0], [1, 1], [0, 1]]),
                                         corners.astype(np.float32))
    depth = np.linspace(0, 0.25, 101)
    gaps = []
    for i in range(4):
        rays = []
        for u in (0.48, 0.49, 0.5, 0.51, 0.52):
            # edge i in square coords, walking inward from it
            sq = {0: (u, depth), 1: (1 - depth, u), 2: (u, 1 - depth), 3: (depth, u)}[i]
            sq = np.stack(np.broadcast_arrays(*sq), axis=1).astype(np.float32)
            p = cv2.perspectiveTransform(sq[None], to_img)[0].round().astype(int)
            p[:, 0] = p[:, 0].clip(0, mask.shape[1] - 1)
            p[:, 1] = p[:, 1].clip(0, mask.shape[0] - 1)
            felt = mask[p[:, 1], p[:, 0]] > 0
            rays.append(depth[felt.argmax()] if felt.any() else depth[-1])
        gaps.append(float(np.median(rays)))
    return gaps


def find_felt(img: np.ndarray) -> FeltFit:
    """Find the felt's 4 outer corners in the photo, ordered to match the table's corners."""
    scale = min(1.0, FELT_WORK_SIDE / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    mask = _felt_mask(small)
    h, w = mask.shape
    if mask.mean() / 255 < 0.08:
        raise VisionError("The table is too small in the photo. Move closer, or zoom in.")

    contour = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0][0].reshape(-1, 2)
    on_border = ((contour[:, 0] <= 1) | (contour[:, 0] >= w - 2) |
                 (contour[:, 1] <= 1) | (contour[:, 1] >= h - 2)).mean()
    if on_border > 0.03:
        raise VisionError("Part of the table is cut off. Get all four rails in the shot.")

    quad = _rough_quad(contour)
    # Clockwise in the photo (y points down), so no matter where we start, the corners go
    # around the same way as the table's top-left -> top-right -> bottom-right -> bottom-left.
    if cv2.contourArea(quad.astype(np.float32), oriented=True) < 0:
        quad = quad[::-1]
    pts = contour.astype(np.float64)
    fits = [_fit_side(pts, quad[i], quad[(i + 1) % 4]) for i in range(4)]
    corners = np.array([_intersect(*fits[i - 1], *fits[i]) for i in range(4)])
    # corners[i] is where edge i-1 meets edge i, i.e. edge i runs corners[i] -> corners[i+1].

    # Long edges have the side pockets. Then call the long edge lower in the photo
    # (usually the one nearest the camera) the bottom; the table is symmetric, so this
    # only decides which way up the top-down view is drawn.
    gaps = _pocket_gaps(mask, corners)
    if abs((gaps[0] + gaps[2]) - (gaps[1] + gaps[3])) < 0.02:
        raise VisionError("Couldn't see the side pockets, so can't tell the long rails from "
                          "the short ones. Make sure nothing is covering them and retake.")
    first_long = 0 if gaps[0] + gaps[2] > gaps[1] + gaps[3] else 1
    bottom = max((first_long, first_long + 2), key=lambda i: (corners[i][1] + corners[(i + 1) % 4][1]))
    top = (bottom + 2) % 4
    order = [top, (top + 1) % 4, (top + 2) % 4, (top + 3) % 4]
    sides = []
    for i, (a, b) in enumerate(zip(quad, np.roll(quad, -1, axis=0))):
        length = np.linalg.norm(b - a)
        dist = np.abs((pts - fits[i][0]) @ np.array([-fits[i][1][1], fits[i][1][0]]))
        sides.append(pts[dist < max(3.0, 0.002 * length)])
    return FeltFit(
        corners=(corners[order] / scale).astype(np.float32),
        mask=mask, scale=scale, sides=[sides[i] for i in order], pocket_gaps=[gaps[i] for i in order],
    )


def felt_homography(fit: FeltFit) -> np.ndarray:
    c = CUSHION_WIDTH
    dst = np.float32([[-c, -c], [TABLE_W + c, -c], [TABLE_W + c, TABLE_H + c], [-c, TABLE_H + c]])
    return cv2.getPerspectiveTransform(fit.corners, dst)


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
def table_homography(img: np.ndarray) -> tuple[np.ndarray, str, list[int], list[int]]:
    """
    Photo -> table homography. Felt outline first; markers only if that fails, so a table
    with markers still works when something hides the felt edges. If both fail, the felt
    error is shown: it's the one the user can most likely fix.
    Returns (H, method, markers used, markers rejected).
    """
    try:
        return felt_homography(find_felt(img)), "felt", [], []
    except VisionError as felt_error:
        markers = find_markers(img)
        if not _well_spread(markers):
            raise felt_error
        try:
            H, rejected = compute_homography(markers)
        except VisionError:
            raise felt_error
        return H, "markers", [i for i in sorted(markers) if i not in rejected], rejected


def analyze_image(img: np.ndarray) -> VisionResult:
    H, method, used, rejected = table_homography(img)
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

    return VisionResult(balls=balls, warped=warped, markers_used=used,
                        markers_rejected=rejected, method=method)

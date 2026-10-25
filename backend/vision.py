"""
CueIQ vision pipeline:  photo -> find the felt's outline (where the table is) -> find the
balls in the photo, mapped onto the table -> name them all at once.

Every number you'll want to tune is in the CONFIG block. Run tools/debug_vision.py on
real photos to see what each stage produces before touching anything else.
"""
import logging
import math
import os
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("cueiq.vision")

# ------------------------------------------------------------------ CONFIG
TABLE_W, TABLE_H = 1000, 500          # table coordinate system (CONTRACT.md)
BALL_RADIUS = 11                      # in table units

# Felt outline: how the table is found. The felt region's outer edge
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
# Ball finding (in the photo, see find_balls).
BALL_WORK_RADIUS = 26      # the photo is resized so the nearest ball is about this many px
BALL_DIFF_GAIN = 4         # color distance from the felt x this = brightness in the diff image
BALL_HOUGH_VOTES = 14      # lower = more circles found (and more false ones)
BALL_MIN_FILL = 0.6        # share of a candidate disc that must differ from the felt
BALL_MIN_CONTRAST = 60     # disc vs the felt around it, in diff-image units (shadows fail)
BALL_EIGHT_CHROMA = 0.55   # or a dark disc with at most this share of the felt's color: the 8
BALL_MIN_HUE_DIFF = 12     # LAB a/b distance from the felt a ball's color must have (not shade)
# Optional trained ball finder (see yolo_balls). BALL_DETECTOR=yolo in .env turns it on.
YOLO_MODEL = Path(__file__).resolve().parent / "models" / "balls.onnx"
YOLO_SIZE = 1024           # model input, px square: must match tools/train_yolo.py
YOLO_CONF = 0.35           # min score for a box to count as a ball
YOLO_NMS = 0.6             # boxes overlapping more than this (IoU) are one ball (balls in a
                           # rack overlap in a low photo: keep this loose, dedupe by distance)
YOLO_TILE_OVERLAP = 0.25   # the left and right halves overlap by this share of a half
YOLO_SAME_BALL = 0.9       # two boxes from one run closer than this x radius are one ball
YOLO_SAME_BALL_PASSES = 1.3  # same, between the full view and a half (their boxes differ more)
TABLE_CROP_MARGIN = 30     # table units of rail/floor kept around the playing area in crops
# --------------------------------------------------------------------------


class VisionError(Exception):
    """Something the user can fix by retaking the photo. Message is shown to them."""


@dataclass
class VisionResult:
    balls: list[dict]
    warped: np.ndarray            # top-down image at DETECT_SCALE, handy for debugging
    detector: str = "circles"     # what found the balls: "circles" or "yolo"


# ------------------------------------------------------------------- 2. warp
def warp_to_table(img: np.ndarray, H: np.ndarray) -> np.ndarray:
    s = DETECT_SCALE
    scale = np.diag([s, s, 1.0])  # table units -> detection pixels
    return cv2.warpPerspective(img, scale @ H, (TABLE_W * s, TABLE_H * s))


# --------------------------------------------------------- 1. the table (felt outline)
# The felt is the biggest, most distinctive thing in the photo, and its far edge stays a
# long sharp line even from a low angle. The cushions are covered in the same cloth, so the felt-colored region ends where the
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
    # A dull felt sits close to neutral, so an off-white wall can be within FELT_CHROMA_TOL
    # of it. Felt is colored and the wall isn't (at least half the felt's color), and the
    # wall is far brighter than any lamp hotspot on the cloth.
    colorful = np.linalg.norm(lab[..., 1:] - 128, axis=2) > 0.5 * np.linalg.norm(felt[1:] - 128)
    lit = (lab[..., 0] > 0.35 * felt[0]) & (lab[..., 0] < 1.7 * felt[0])
    mask = ((chroma < FELT_CHROMA_TOL) & colorful & lit).astype(np.uint8) * 255
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
# Balls are found in the PHOTO, not the top-down warp. The warp flattens the felt plane,
# but a ball sticks up out of it: from a low angle the warp smears each ball into a streak
# several balls long, which gave two detections per ball and colors mixed with the felt.
# In the photo a ball is still a round disc. We find the discs there and map only each
# center through the homography (the felt fit maps cushion-top height, about ball-center
# height, so centers land in the right spot).

def _ball_radius_px(to_photo: np.ndarray, x: float, y: float) -> float:
    """A ball's radius in photo px at table point (x, y). A sphere looks the same size in
    every direction, so use the table's least-foreshortened scale there."""
    p = cv2.perspectiveTransform(np.float32([[[x, y], [x + 1, y], [x, y + 1]]]), to_photo)[0]
    J = np.array([p[1] - p[0], p[2] - p[0]])
    return BALL_RADIUS * float(np.linalg.svd(J, compute_uv=False)[0])


def find_balls(img: np.ndarray, H: np.ndarray) -> tuple[np.ndarray, list[tuple]]:
    """
    Ball discs in the photo. Returns (the photo resized for detection;
    [(table x, table y, x, y, r) ...] with x, y, r in that resized photo's px).
    """
    to_photo = np.linalg.inv(H)
    grid = [(x, y) for x in np.linspace(0, TABLE_W, 5) for y in np.linspace(0, TABLE_H, 3)]
    radii = [_ball_radius_px(to_photo, x, y) for x, y in grid]
    s = min(1.0, BALL_WORK_RADIUS / max(radii))
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    to_small = np.diag([s, s, 1.0]) @ to_photo
    r_min, r_max = min(radii) * s, max(radii) * s

    # Where ball centers can be: the playing area, as seen in the photo.
    area = cv2.perspectiveTransform(
        np.float32([[[0, 0], [TABLE_W, 0], [TABLE_W, TABLE_H], [0, TABLE_H]]]), to_small)[0]
    roi = np.zeros(small.shape[:2], np.uint8)
    cv2.fillConvexPoly(roi, area.round().astype(np.int32), 255)

    # "How different from the felt" image: felt goes black, any ball, whatever its color,
    # goes bright. Brightness counts for half, so shading on the cloth doesn't light up
    # but a dark ball (blue, maroon) on the cloth still does. (The 8 barely shows here;
    # it's let in by its darkness against the felt around it, below.)
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    felt = np.median(lab[roi > 0], axis=0)
    felt_chroma = float(np.hypot(felt[1] - 128, felt[2] - 128))
    d = lab - felt
    dl = 0.5 * d[..., 0]
    diff = np.sqrt(dl ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)
    diff = np.clip(diff * BALL_DIFF_GAIN, 0, 255).astype(np.uint8)
    diff[cv2.dilate(roi, np.ones((3, 3), np.uint8), iterations=int(r_max) + 2) == 0] = 0

    circles = cv2.HoughCircles(
        cv2.GaussianBlur(diff, (5, 5), 1.2), cv2.HOUGH_GRADIENT, dp=1,
        minDist=r_min * 1.2,      # touching balls are ~2 radii apart; dupes are removed below
        param1=80,                # edge strength (Canny high threshold)
        param2=BALL_HOUGH_VOTES,  # lower = more circles found (and more false ones)
        minRadius=int(r_min * 0.7), maxRadius=int(np.ceil(r_max * 1.3)),
    )
    if circles is None:
        return small, []

    found = []
    yy, xx = np.mgrid[0:small.shape[0], 0:small.shape[1]]
    for cx, cy, r in circles[0]:
        tx, ty = cv2.perspectiveTransform(np.float32([[[cx / s, cy / s]]]), H)[0, 0]
        # A ball's center is at least a radius from the cushion (some slack for the fit);
        # circles past that are pocket holes and cushion faces.
        edge = 0.5 * BALL_RADIUS
        if not (edge < tx < TABLE_W - edge and edge < ty < TABLE_H - edge):
            continue
        want = _ball_radius_px(to_photo, tx, ty) * s
        # Loose: Hough may fit just a small far ball's bright top, or take in its shadow.
        # The checks below use the predicted size, so they still judge it fairly.
        if not 0.6 * want < r < 1.6 * want:
            continue
        # Most of a real ball differs from the felt; a fold or chalk mark doesn't. And it
        # stands out from the felt right around it, which a shadow (by a pocket) doesn't.
        x0, x1 = int(max(0, cx - 2 * want)), int(cx + 2 * want + 1)
        y0, y1 = int(max(0, cy - 2 * want)), int(cy + 2 * want + 1)
        d2 = (xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2
        patch = diff[y0:y1, x0:x1].astype(np.float32)
        inside = patch[d2 < (0.8 * want) ** 2]
        ring = patch[(d2 > (1.4 * want) ** 2) & (d2 < (1.9 * want) ** 2)]
        solid = (inside > 90).mean() if inside.size else 0.0
        # The ring's quieter half: a neighboring ball can fill part of it.
        around = np.percentile(ring, 40) if ring.size else 0.0
        stands_out = solid >= BALL_MIN_FILL and np.median(inside) - around >= BALL_MIN_CONTRAST
        if not stands_out:
            # The 8: black on dark felt is mostly a brightness difference, which the diff
            # image halves, and its reflections keep it from looking much darker. What
            # gives it away is that it has no color, while felt (even in shadow) does.
            disc = lab[y0:y1, x0:x1][d2 < (0.8 * want) ** 2]
            Lring = lab[y0:y1, x0:x1, 0][(d2 > (1.4 * want) ** 2) & (d2 < (1.9 * want) ** 2)]
            chroma = np.median(np.hypot(disc[:, 1] - 128, disc[:, 2] - 128))
            darker = np.percentile(Lring, 60) - np.median(disc[:, 0]) if Lring.size else 0
            if chroma > BALL_EIGHT_CHROMA * felt_chroma or darker < 0:
                continue
            solid = 0.5   # rank it below the clear finds when removing overlaps
        # From a low angle the pocket holes poke into the playing area as dark discs the
        # size of a ball: dark, by a corner or pressed against a rail by a pocket. (An 8-ball
        # frozen in a corner jaw is lost to this.)
        near_corner = min(np.hypot(tx - px, ty - py) for px in (0, TABLE_W) for py in (0, TABLE_H))
        near_rail = min(tx, TABLE_W - tx, ty, TABLE_H - ty)
        brightness = np.median(lab[y0:y1, x0:x1, 0][d2 < (0.8 * want) ** 2])
        in_pocket = near_corner < 2.8 * BALL_RADIUS or (near_corner < 5 * BALL_RADIUS
                                                        and near_rail < 1.5 * BALL_RADIUS)
        if in_pocket and brightness < 90:
            continue
        # Every ball, white and the 8 included, is a different color from the felt. A
        # cushion face or shadow is the felt's own color, only darker.
        disc = lab[y0:y1, x0:x1][d2 < (0.8 * want) ** 2]
        if np.median(np.hypot(disc[:, 1] - felt[1], disc[:, 2] - felt[2])) < BALL_MIN_HUE_DIFF:
            continue
        # Hough's own fit hugs the ball's edge better than the predicted size.
        size = float(np.clip(r, 0.9 * want, 1.3 * want))
        found.append((solid, float(tx), float(ty), float(cx), float(cy), size))

    # Strongest first; drop anything overlapping a ball we already kept (one ball, two hits).
    kept = []
    for solid, tx, ty, cx, cy, r in sorted(found, reverse=True):
        if all(np.hypot(tx - k[0], ty - k[1]) > 1.8 * BALL_RADIUS for k in kept):   # touching = 2
            kept.append((tx, ty, cx, cy, r))
    return small, kept


# What each ball looks like, from the LAB color of its colored pixels, measured on real
# photos: hue angle in degrees, atan2(b - 128, a - 128). Stripes 9-15 match 1-7.
BALL_HUE = {1: 90, 2: -85, 3: 33, 4: -63, 5: 58, 6: 150, 7: 33}
BALL_CHROMA = {3: 70, 7: 45}   # red and maroon share a hue: maroon is the duller one
WHITE_TOL = 16                 # a/b distance from the photo's white to count as white
CLASSES = [("cue", None)] + [("eight", 8)] + [("solid", n) for n in range(1, 8)] \
    + [("stripe", n + 8) for n in range(1, 8)]


def _ball_patches(img: np.ndarray, found: list[tuple], scale: float) -> list[tuple]:
    """For each ball, the full-resolution photo around it as LAB, plus every pixel's
    distance from the ball's center in radii. Identification reads full resolution:
    shrunk, a stripe's band seen edge-on blurs into gray."""
    out = []
    for _, _, cx, cy, r in found:
        X, Y, R = cx / scale, cy / scale, r / scale
        x0, y0 = max(0, int(X - 2 * R)), max(0, int(Y - 2 * R))
        x1, y1 = min(img.shape[1], int(X + 2 * R) + 1), min(img.shape[0], int(Y + 2 * R) + 1)
        patch = cv2.GaussianBlur(img[y0:y1, x0:x1], (3, 3), 0)
        lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        out.append((lab, np.hypot(xx - X, yy - Y) / R))
    return out


def _white_point(patches: list[tuple]) -> np.ndarray:
    """The a/b color of 'white' in this photo. Warm light makes the cue ball cream, so a
    fixed white test misses it. Take the bright near-neutral pixels on the balls."""
    px = [lab[dist < 0.85] for lab, dist in patches]
    px = np.concatenate(px) if px else np.empty((0, 3))
    px = px[(px[:, 0] > 200) & (np.hypot(px[:, 1] - 128, px[:, 2] - 128) < 40)]
    return np.median(px[:, 1:], axis=0) if len(px) > 50 else np.array([124.0, 140.0])


def _felt_around(patches: list[tuple]) -> np.ndarray:
    """The felt's LAB color, from a ring just outside each ball."""
    px = [lab[(dist > 1.4) & (dist < 1.9)] for lab, dist in patches]
    return np.median(np.concatenate(px), axis=0) if px else np.array([100.0, 110.0, 135.0])


def _features(lab: np.ndarray, dist: np.ndarray, white_ab: np.ndarray, felt: np.ndarray) -> dict:
    """How much of the ball is white / dark neutral / colored, and what color."""
    # Out to the rim: a stripe turned band-away shows its color only at the edges.
    px = lab[dist < 1.0]
    d = px - felt
    px = px[np.sqrt(0.25 * d[:, 0] ** 2 + d[:, 1] ** 2 + d[:, 2] ** 2) > 20]   # felt at the rim
    if len(px) == 0:
        return {"white": 0.0, "dark": 0.0, "colored": 0.0, "hue": None, "chroma": 0.0}
    L, A, B = px.T
    chroma = np.hypot(A - 128, B - 128)
    # White by color, not brightness: the shaded half of a white ball is still white.
    from_white = np.hypot(A - white_ab[0], B - white_ab[1])
    white = (from_white < WHITE_TOL) & (L > 120)
    dark = (L < 110) & (chroma < 15)            # the 8's body (reflections keep it off black)
    # Clearly not white: warm shading on a white ball drifts a little toward yellow.
    # Down to fairly dark: a purple or maroon band in dim light sits well below mid-gray.
    colored = (from_white > 1.6 * WHITE_TOL) & ~dark & (chroma > 18) & (L > 30)
    f = {"white": white.mean(), "dark": dark.mean(), "colored": colored.mean(),
         "hue": None, "chroma": 0.0}
    if colored.sum() >= 5:
        # Circular mean, weighted by how colorful each pixel is.
        ang = np.arctan2(B[colored] - 128, A[colored] - 128)
        w = chroma[colored]
        f["hue"] = float(np.degrees(np.arctan2((w * np.sin(ang)).sum(), (w * np.cos(ang)).sum())))
        f["chroma"] = float(np.median(chroma[colored]))
    return f


def _cost(f: dict, kind: str, number: int | None) -> float:
    """How badly a ball with features f fits this class. 0 = perfect."""
    if kind == "cue":
        # Mostly by having no real color: warm light leaves part of it in-between cream.
        return (f["colored"] + f["dark"]) * 3 + (1 - f["white"]) * 0.5
    if kind == "eight":
        return (1 - min(1.0, f["dark"] / 0.5)) * 2 + f["white"]
    base = number - 8 if kind == "stripe" else number
    if f["hue"] is None:
        color = 1.5
    else:
        diff = abs((f["hue"] - BALL_HUE[base] + 180) % 360 - 180)
        color = min(diff / 25, 3.0)
        if base in BALL_CHROMA:
            color += abs(f["chroma"] - BALL_CHROMA[base]) / 25
    # A solid shows white only in its number circle and highlights; a stripe shows more,
    # up to nearly all white when its band is turned away.
    if kind == "solid":
        shape = max(0.0, f["white"] - 0.25) * 4
    else:
        shape = max(0.0, 0.3 - f["white"]) * 4
    # A few warm pixels on a white ball aren't a stripe: the hue only counts with some color.
    scarce = max(0.0, 0.08 - f["colored"]) * 12
    return color + shape + scarce + f["dark"] * 2


def _class_of(ball: str) -> tuple[str, int | None]:
    """Game ball name ("cue", "1".."15") -> CLASSES entry."""
    if ball == "cue":
        return ("cue", None)
    n = int(ball)
    return ("eight", 8) if n == 8 else ("solid", n) if n < 8 else ("stripe", n)


def _improve_by_swaps(out: list[dict | None], costs: np.ndarray, classes: list[tuple]) -> None:
    """Greedy naming can lose overall: the red 11 grabs "15" because it fits that a bit
    better than the real 15 does, leaving the 15 a bad "11". Swap names between pairs of
    balls (or to an unused name) while that lowers the total cost."""
    index = {c: k for k, c in enumerate(classes)}
    assigned = [index[(o["type"], o["id"])] if o else None for o in out]
    for _ in range(10):
        better = False
        for i in range(len(out)):
            if assigned[i] is None:
                continue
            for j in range(len(out)):                    # swap with another ball
                a, b = assigned[i], assigned[j]
                if j <= i or b is None:
                    continue
                if costs[i, b] + costs[j, a] < costs[i, a] + costs[j, b] - 1e-9:
                    assigned[i], assigned[j], better = b, a, True
            used = set(assigned)
            for c in range(len(classes)):                # move to a name nobody has
                if c not in used and costs[i, c] < costs[i, assigned[i]] - 1e-9:
                    used.discard(assigned[i]); used.add(c)
                    assigned[i], better = c, True
        if not better:
            break
    for i, c in enumerate(assigned):
        if c is not None and (out[i]["type"], out[i]["id"]) != classes[c]:
            kind, number = classes[c]
            # A swapped name was nobody's first choice: as sure as its margin over the next.
            margin = float(np.delete(costs[i], c).min() - costs[i, c])
            out[i] = {"type": kind, "id": number,
                      "confidence": round(max(0.3, min(1.0, 0.5 + margin / 2)), 2)}


def classify_all(img: np.ndarray, found: list[tuple], scale: float,
                 allowed: set[str] | None = None) -> list[dict]:
    """
    Name every ball at once. Each photo has one cue ball and one of each number, so
    instead of naming balls one by one (two "2"s, no 10) we score every ball against all
    16 and hand out the best fits first. `found` is from find_balls, whose px are the
    photo resized by `scale`; `img` is the full photo. `allowed`: the balls still in play
    ("cue", "1".."15"); a pocketed ball is never a candidate name.
    """
    if not found:
        return []
    classes = CLASSES if allowed is None else [c for c in CLASSES if c in {_class_of(b) for b in allowed}]
    if not classes:
        return [{"type": "solid", "id": None, "confidence": 0.3} for _ in found]
    patches = _ball_patches(img, found, scale)
    white_ab, felt = _white_point(patches), _felt_around(patches)
    feats = [_features(lab, dist, white_ab, felt) for lab, dist in patches]
    costs = np.array([[_cost(f, k, n) for k, n in classes] for f in feats])

    out: list[dict | None] = [None] * len(feats)
    taken = set()
    for flat in np.argsort(costs, axis=None):
        i, c = divmod(int(flat), len(classes))
        if out[i] is not None or c in taken:
            continue
        others = np.delete(costs[i], c)
        # Sure when this fit is good AND clearly better than the ball's next best guess.
        margin = float(others.min() - costs[i, c]) if len(others) else 1.0
        conf = max(0.3, min(1.0, 0.5 + margin / 2 - max(0.0, costs[i, c] - 0.5) / 2))
        kind, number = classes[c]
        out[i] = {"type": kind, "id": number, "confidence": round(conf, 2)}
        taken.add(c)
    _improve_by_swaps(out, costs, classes)
    for i, o in enumerate(out):   # more balls than numbers: best guess, flagged for correction
        if o is None:
            kind, number = classes[int(costs[i].argmin())]
            out[i] = {"type": kind, "id": number, "confidence": 0.3}
    return out


# ------------------------------------------------------------- 3b. balls, trained model
# Optional: a YOLOv8n detector trained on our own photos (tools/export_yolo.py, then
# tools/train_yolo.py) finds the balls instead of the circle search; it copes better with
# touching balls, like a rack. It only finds them: naming is classify_all either way.
# On when BALL_DETECTOR=yolo and the model loads; otherwise, or on any error, find_balls.

def table_crop(img: np.ndarray, H: np.ndarray) -> tuple[int, int, int, int]:
    """Photo px box (x0, y0, x1, y1) around the playing area plus a margin. Training
    crops and live detection use the same box, so the model sees what it learned on."""
    m = TABLE_CROP_MARGIN
    corners = np.float32([[[-m, -m], [TABLE_W + m, -m], [TABLE_W + m, TABLE_H + m], [-m, TABLE_H + m]]])
    p = cv2.perspectiveTransform(corners, np.linalg.inv(H))[0]
    x0, y0 = np.floor(p.min(axis=0)).astype(int)
    x1, y1 = np.ceil(p.max(axis=0)).astype(int)
    h, w = img.shape[:2]
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


_yolo_net = None
_yolo_tried = False


def _yolo_model():
    """The ONNX net, loaded once. None if it's off, missing or broken."""
    global _yolo_net, _yolo_tried
    if os.getenv("BALL_DETECTOR", "circles") != "yolo":
        return None
    if not _yolo_tried:
        _yolo_tried = True
        path = Path(os.getenv("YOLO_MODEL", YOLO_MODEL))
        try:
            _yolo_net = cv2.dnn.readNetFromONNX(str(path))
        except cv2.error as e:
            log.warning("BALL_DETECTOR=yolo but %s didn't load, using circles: %s", path, e)
    return _yolo_net


def _letterbox(img: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Resize to fit a size x size square, padded gray like YOLO's training. Returns
    (square image, scale, left pad, top pad)."""
    h, w = img.shape[:2]
    k = size / max(h, w)
    nw, nh = round(w * k), round(h * k)
    out = np.full((size, size, 3), 114, np.uint8)
    left, top = (size - nw) // 2, (size - nh) // 2
    out[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    return out, k, left, top


def decode_yolo(out: np.ndarray, conf: float = YOLO_CONF, nms: float = YOLO_NMS) -> list[tuple]:
    """YOLOv8 output (1, 4 + classes, N) -> [(cx, cy, w, h, score)] in input px, after NMS."""
    pred = out[0].T                                   # (N, 4 + classes)
    scores = pred[:, 4:].max(axis=1)
    pred, scores = pred[scores >= conf], scores[scores >= conf]
    if len(pred) == 0:
        return []
    boxes = [[float(cx - w / 2), float(cy - h / 2), float(w), float(h)] for cx, cy, w, h in pred[:, :4]]
    keep = cv2.dnn.NMSBoxes(boxes, scores.astype(float).tolist(), conf, nms)
    return [(*pred[i, :4].astype(float), float(scores[i])) for i in np.array(keep).reshape(-1)]


def _yolo_pass(net, img: np.ndarray, box: tuple, seams: tuple = ()) -> list[tuple]:
    """One model run on a photo region: [(x, y, r, score)] in photo px. `seams`: sides
    ("left"/"right") cut through the table; a ball touching one is only partly in this
    region, and the region beside it has it whole, so it's skipped here."""
    x0, y0, x1, y1 = box
    square, k, left, top = _letterbox(img[y0:y1, x0:x1], YOLO_SIZE)
    net.setInput(cv2.dnn.blobFromImage(square, 1 / 255.0, swapRB=True))
    out = []
    for bx, by, bw, bh, score in decode_yolo(net.forward()):
        x, y, r = (bx - left) / k + x0, (by - top) / k + y0, (bw + bh) / 4 / k
        if ("left" in seams and x - r < x0 + 2) or ("right" in seams and x + r > x1 - 2):
            continue
        out.append((x, y, r, score))
    return out


def yolo_balls(img: np.ndarray, H: np.ndarray) -> list[tuple] | None:
    """
    Balls from the trained model, in find_balls' format but full-resolution px:
    [(table x, table y, x, y, r)]. None when the model is off or fails, so the caller
    falls back to find_balls.

    The whole table shrunk to the model's input leaves a far ball ~17 px wide, too small
    to split touching balls (a rack). So it also runs on the left and right halves (a bit
    of overlap), where balls are twice the size. The full view goes first; a half's ball
    is new only if no ball already kept is within YOLO_SAME_BALL_PASSES radii.
    Duplicates are judged in the photo, where touching balls are two radii apart.
    """
    net = _yolo_model()
    if net is None:
        return None
    x0, y0, x1, y1 = table_crop(img, H)
    half = int((x1 - x0) / 2 * (1 + YOLO_TILE_OVERLAP))
    try:
        passes = [_yolo_pass(net, img, (x0, y0, x1, y1)),
                  _yolo_pass(net, img, (x0, y0, x0 + half, y1), ("right",)),
                  _yolo_pass(net, img, (x1 - half, y0, x1, y1), ("left",))]
    except cv2.error as e:
        log.warning("YOLO ball detection failed, using circles: %s", e)
        return None
    found = []
    edge = 0.5 * BALL_RADIUS                          # same limits as find_balls
    for n, boxes in enumerate(passes):
        same = YOLO_SAME_BALL if n == 0 else YOLO_SAME_BALL_PASSES
        for x, y, r, _ in sorted(boxes, key=lambda b: -b[3]):
            tx, ty = cv2.perspectiveTransform(np.float32([[[x, y]]]), H)[0, 0]
            if not (edge < tx < TABLE_W - edge and edge < ty < TABLE_H - edge):
                continue
            if any(math.hypot(x - f[2], y - f[3]) < same * max(r, f[4]) for f in found):
                continue
            found.append((float(tx), float(ty), float(x), float(y), float(r)))
    return found


# ------------------------------------------------------------------ pipeline
def table_homography(img: np.ndarray) -> np.ndarray:
    """Photo -> table homography, from the felt's outline."""
    return felt_homography(find_felt(img))


def analyze_image(img: np.ndarray, allowed: set[str] | None = None) -> VisionResult:
    """allowed: limit the names to these balls ("cue", "1".."15"). None = all 16, which is
    what games use: the game's memory, not vision, decides what's still in play."""
    H = table_homography(img)
    warped = warp_to_table(img, H)
    found, scale, detector = yolo_balls(img, H), 1.0, "yolo"
    if found is None:
        small, found = find_balls(img, H)
        scale, detector = small.shape[1] / img.shape[1], "circles"
    names = classify_all(img, found, scale, allowed)
    balls = [{**info, "x": round(tx, 1), "y": round(ty, 1)} for info, (tx, ty, *_) in zip(names, found)]
    return VisionResult(balls=balls, warped=warped, detector=detector)

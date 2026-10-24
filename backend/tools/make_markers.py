"""
Make a printable sheet of every marker in vision.MARKERS.
    python tools/make_markers.py            -> markers.pdf, sizes from vision.MARKER_SIZE_CM
    python tools/make_markers.py --cm 4     -> every marker 4 cm (then set MARKER_SIZE_CM to match!)
Print at 100% scale (turn OFF "fit to page"), cut along the dashed lines, and tape each
flat on the rail behind the pocket its label names, with its ARROW POINTING STRAIGHT
ACROSS THE TABLE, TOWARD THE FELT. The vision code uses every corner of every marker, so
the arrow direction matters. Keep the white border around the black square: the detector
needs it to find the marker's edge. Uses more than one page if the markers don't fit.
"""
import argparse
import sys
from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vision import ARUCO_DICT, MARKER_SIZE_CM, MARKERS  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--cm", type=float, help="width of every black square, in cm "
                "(default: each marker's size from vision.MARKER_SIZE_CM)")
args = ap.parse_args()
sizes = {mid: args.cm or MARKER_SIZE_CM[mid] for mid in MARKERS}

DPI = 300
PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)   # US Letter
MARGIN, TOP = 100, 220                           # page margin, space for the page title
GAP = 60                                         # between cut boxes
ARROW_H, LABEL_H = 150, 100                      # strips above / below the marker
px_per_cm = DPI / 2.54


def font(size):
    for name in ("Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def dashed_box(draw, box):
    x0, y0, x1, y1 = box
    for i in range(x0, x1, 30):
        draw.line([(i, y0), (min(i + 15, x1), y0)], fill="gray", width=3)
        draw.line([(i, y1), (min(i + 15, x1), y1)], fill="gray", width=3)
    for j in range(y0, y1, 30):
        draw.line([(x0, j), (x0, min(j + 15, y1))], fill="gray", width=3)
        draw.line([(x1, j), (x1, min(j + 15, y1))], fill="gray", width=3)


def new_page():
    page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    title = "CueIQ markers. Print at 100% scale. Arrows point across the table, toward the felt."
    ImageDraw.Draw(page).text((PAGE_W // 2, 110), title, fill="black", font=font(38), anchor="mm")
    return page


d = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
pages = [new_page()]
x, y, row_h = MARGIN, TOP, 0
for mid, (name, _) in MARKERS.items():
    side = int(sizes[mid] * px_per_cm)           # black square
    quiet = side // 4                            # white border (needs at least 1 cell = side/6)
    w = max(side + 2 * quiet, 500)               # wide enough for the label text
    h = ARROW_H + side + 2 * quiet + LABEL_H
    if w > PAGE_W - 2 * MARGIN or h > PAGE_H - TOP - MARGIN:
        sys.exit(f"Marker #{mid} at {sizes[mid]:g} cm doesn't fit on a page. Use a smaller size.")
    if x + w > PAGE_W - MARGIN:                  # next row
        x, y, row_h = MARGIN, y + row_h + GAP, 0
    if y + h > PAGE_H - MARGIN:                  # next page
        pages.append(new_page())
        x, y, row_h = MARGIN, TOP, 0

    page = pages[-1]
    draw = ImageDraw.Draw(page)
    cx = x + w // 2
    mx, my = cx - side // 2, y + ARROW_H + quiet  # marker's top-left
    page.paste(Image.fromarray(cv2.aruco.generateImageMarker(d, mid, side)).convert("RGB"), (mx, my))
    # Arrow above the white border, pointing at the marker's "top". Gray and kept outside
    # the quiet zone so the detector never mistakes it for part of the marker.
    tip, base = y + 20, y + ARROW_H - 30
    draw.polygon([(cx, tip), (cx - 45, tip + 60), (cx + 45, tip + 60)], fill="dimgray")
    draw.line([(cx, tip + 50), (cx, base)], fill="dimgray", width=18)
    draw.text((cx + 60, (tip + base) // 2), "felt", fill="dimgray", font=font(36), anchor="lm")
    draw.text((cx, my + side + quiet + LABEL_H // 2), f"{name}  #{mid}  ({sizes[mid]:g} cm)",
              fill="black", font=font(36), anchor="mm")
    dashed_box(draw, (x, y, x + w, y + h))
    x += w + GAP
    row_h = max(row_h, h)

out = Path("markers.pdf")
pages[0].save(out, resolution=DPI, save_all=True, append_images=pages[1:])
desc = f"{args.cm:g} cm" if args.cm else "sizes from MARKER_SIZE_CM"
print(f"Wrote {out.resolve()} ({len(MARKERS)} markers, {desc}, {len(pages)} page(s))")
if args.cm and any(MARKER_SIZE_CM[m] != args.cm for m in MARKERS):
    print(f"Reminder: set MARKER_SIZE_CM in vision.py to {args.cm:g} for these markers.")

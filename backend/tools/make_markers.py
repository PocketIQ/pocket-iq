"""
Make a printable sheet of every marker in vision.MARKERS, all on one page.
    python tools/make_markers.py            -> markers.pdf, 5 cm markers (recommended)
    python tools/make_markers.py --cm 4     -> smaller; only if your photos are close/overhead
Print at 100% scale (turn OFF "fit to page"), cut along the dashed lines, and tape each
flat on the rail behind the pocket its label names. Keep the white border around the
black square: the detector needs it to find the marker's edge.
"""
import argparse
import sys
from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vision import ARUCO_DICT, MARKERS  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--cm", type=float, default=5.0, help="width of the black square, in cm")
args = ap.parse_args()

DPI = 300
PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)   # US Letter
px_per_cm = DPI / 2.54
side = int(args.cm * px_per_cm)                  # black square
quiet = side // 4                                # white border (needs at least 1 cell = side/6)
cell_w, cell_h = side + 2 * quiet + 60, side + 2 * quiet + 140
cols = max(1, (PAGE_W - 200) // cell_w)

def font(size):
    for name in ("Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)

d = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
page = Image.new("RGB", (PAGE_W, PAGE_H), "white")
draw = ImageDraw.Draw(page)
draw.text((PAGE_W // 2, 110), f"CueIQ markers - {args.cm:g} cm. Print at 100% scale.",
          fill="black", font=font(50), anchor="mm")

x0 = (PAGE_W - cols * cell_w) // 2
for n, (mid, (name, _)) in enumerate(MARKERS.items()):
    cx = x0 + (n % cols) * cell_w
    cy = 220 + (n // cols) * cell_h
    marker = cv2.aruco.generateImageMarker(d, mid, side)
    page.paste(Image.fromarray(marker).convert("RGB"), (cx + 30 + quiet, cy + quiet))
    # dashed cut line around marker + its white border + label
    box = (cx + 30, cy, cx + 30 + side + 2 * quiet, cy + side + 2 * quiet + 90)
    for i in range(box[0], box[2], 30):
        draw.line([(i, box[1]), (min(i + 15, box[2]), box[1])], fill="gray", width=3)
        draw.line([(i, box[3]), (min(i + 15, box[2]), box[3])], fill="gray", width=3)
    for j in range(box[1], box[3], 30):
        draw.line([(box[0], j), (box[0], min(j + 15, box[3]))], fill="gray", width=3)
        draw.line([(box[2], j), (box[2], min(j + 15, box[3]))], fill="gray", width=3)
    draw.text(((box[0] + box[2]) // 2, cy + side + 2 * quiet + 40),
              f"{name}  #{mid}", fill="black", font=font(40), anchor="mm")

if 220 + ((len(MARKERS) - 1) // cols + 1) * cell_h > PAGE_H:
    sys.exit("Markers don't fit on one page at this size. Use a smaller --cm.")
out = Path("markers.pdf")
page.save(out, resolution=DPI)
print(f"Wrote {out.resolve()} ({len(MARKERS)} markers, {args.cm:g} cm, {cols} per row)")

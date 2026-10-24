"""
Turn table photos into a YOLO training set for the ball detector, labeled by the current
circle-search pipeline (vision.find_balls). Those labels are a head start, not the truth:
check them, and fix the misses (racks especially) before training.
    python tools/export_yolo.py photos ~/Downloads/Photos        -> yolo/dataset/
    python tools/export_yolo.py photos --out yolo/dataset --val-every 6

Each photo is cropped to the table (vision.table_crop, the same crop live detection uses)
and shrunk to EXPORT_SIDE px on its long side. Writes:
  images/{train,val}/<name>.jpg     the crops
  labels/{train,val}/<name>.txt     one line per ball: "0 cx cy w h", all 0-1 of the crop
  preview/<name>.jpg                the crop with every label drawn, to check by eye
  dataset.yaml                      what tools/train_yolo.py (Ultralytics) reads

To fix labels: CVAT, Label Studio, makesense.ai and Roboflow all import this "YOLO" layout
(images + labels folders). Correct the boxes, export as YOLO again over these files.
Photos where the table can't be found are skipped and listed.
"""
import argparse
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vision import VisionError, find_balls, table_crop, table_homography  # noqa: E402

EXPORT_SIDE = 1280      # px, long side of each saved crop (training resizes to YOLO_SIZE anyway)
EXTENSIONS = {".jpg", ".jpeg", ".png"}

ap = argparse.ArgumentParser()
ap.add_argument("sources", nargs="+", help="photo files or folders of photos")
ap.add_argument("--out", default="yolo/dataset", help="dataset folder (default: yolo/dataset)")
ap.add_argument("--val-every", type=int, default=6,
                help="every Nth photo goes to validation instead of training (default: 6)")
args = ap.parse_args()

photos = []
for src in map(Path, args.sources):
    src = src.expanduser()
    photos += sorted(p for p in src.iterdir() if p.suffix.lower() in EXTENSIONS) if src.is_dir() else [src]
if not photos:
    sys.exit("No photos found.")

out = Path(args.out)
for d in ("images/train", "images/val", "labels/train", "labels/val", "preview"):
    (out / d).mkdir(parents=True, exist_ok=True)

counts, skipped = {"train": 0, "val": 0}, []
total_balls = 0
for i, path in enumerate(photos):
    img = cv2.imread(str(path))
    if img is None:
        skipped.append(f"{path.name} (not an image)")
        continue
    try:
        H = table_homography(img)
    except VisionError as e:
        skipped.append(f"{path.name} ({e})")
        continue
    small, found = find_balls(img, H)
    s = small.shape[1] / img.shape[1]          # find_balls px -> photo px: divide by s

    x0, y0, x1, y1 = table_crop(img, H)
    crop = img[y0:y1, x0:x1]
    k = EXPORT_SIDE / max(crop.shape[:2])
    crop = cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    ch, cw = crop.shape[:2]

    lines, preview = [], crop.copy()
    for _, _, cx, cy, r in found:
        # photo px -> crop px
        x, y, rad = (cx / s - x0) * k, (cy / s - y0) * k, r / s * k
        lines.append(f"0 {x / cw:.6f} {y / ch:.6f} {2 * rad / cw:.6f} {2 * rad / ch:.6f}")
        cv2.rectangle(preview, (int(x - rad), int(y - rad)), (int(x + rad), int(y + rad)), (0, 0, 255), 2)
    cv2.putText(preview, f"{path.stem}: {len(lines)} balls", (10, 40), cv2.FONT_HERSHEY_SIMPLEX,
                1.2, (0, 0, 255), 3)

    split = "val" if args.val_every and i % args.val_every == args.val_every - 1 else "train"
    cv2.imwrite(str(out / "images" / split / f"{path.stem}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
    (out / "labels" / split / f"{path.stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
    cv2.imwrite(str(out / "preview" / f"{path.stem}.jpg"), preview, [cv2.IMWRITE_JPEG_QUALITY, 80])
    counts[split] += 1
    total_balls += len(lines)
    print(f"{path.name}: {len(lines)} balls -> {split}")

(out / "dataset.yaml").write_text(
    f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n")
print(f"\nWrote {counts['train']} train + {counts['val']} val photos, {total_balls} balls, to {out.resolve()}")
if skipped:
    print("Skipped:\n  " + "\n  ".join(skipped))
print("Check preview/ and fix wrong or missing boxes before training (see this file's docstring).")

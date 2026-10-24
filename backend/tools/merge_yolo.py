"""
Mix an outside YOLO dataset (a Roboflow "YOLOv8" export) into ours for training.
    python tools/merge_yolo.py ~/Downloads/billiard-vision           -> yolo/merged/
    python tools/merge_yolo.py ~/Downloads/a ~/Downloads/b --cap 300 --repeat-ours 4
    python tools/train_yolo.py --data yolo/merged/dataset.yaml

  - Every ball class becomes class 0 "ball". We only need where balls are; naming them
    stays with vision.classify_all. Classes that aren't balls (cue stick, table, pocket,
    ...) are dropped: the script prints which is which, override with --keep / --drop.
    Check that list: a class named just "cue" is the cue ball in some sets and the stick
    in others (look at a few of its images; --drop cue if it's the stick).
  - Segmentation labels (polygons) are turned into boxes.
  - At most --cap outside images (a random, repeatable pick), all into training, so they
    don't drown out our photos. Ours go in --repeat-ours times for the same reason.
  - Validation is our photos only, so the score it reports is for our tables and phones.

Ours is yolo/dataset from tools/export_yolo.py (fix its labels first). A Roboflow export
has train/, valid/ and test/ folders, each with images/ and labels/, plus data.yaml; all
three splits are used, since its own validation split means nothing here.
"""
import argparse
import random
import re
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
# Class names that are clearly not a ball. Anything else counts as one: "ball", "cue",
# "8ball", "solid", "stripes", "1".."15", "red", "yellow", ...
NOT_BALL = re.compile(r"stick|table|pocket|hole|rail|cushion|hand|person|player|chalk|rack|"
                      r"triangle|bridge|diamond|tip|edge|corner", re.I)

ap = argparse.ArgumentParser()
ap.add_argument("outside", nargs="+", help="Roboflow YOLO export folder(s) (each with data.yaml)")
ap.add_argument("--ours", default=str(ROOT / "yolo/dataset"), help="our set (default: yolo/dataset)")
ap.add_argument("--out", default=str(ROOT / "yolo/merged"), help="merged set (default: yolo/merged)")
ap.add_argument("--cap", type=int, default=500, help="max outside images in total (default: 500)")
ap.add_argument("--repeat-ours", type=int, default=3, help="copies of each of our training photos (default: 3)")
ap.add_argument("--keep", nargs="*", default=[], help="outside class names to count as balls anyway")
ap.add_argument("--drop", nargs="*", default=[], help="outside class names to drop anyway")
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()


def class_names(root: Path) -> list[str]:
    data = yaml.safe_load((root / "data.yaml").read_text())
    names = data.get("names", [])
    if isinstance(names, dict):                      # {0: "ball", 1: "cue"}
        names = [names[k] for k in sorted(names, key=int)]
    return [str(n) for n in names]


def is_ball(name: str) -> bool:
    if name in args.keep:
        return True
    if name in args.drop:
        return False
    return not NOT_BALL.search(name)


def to_box(parts: list[str]) -> str | None:
    """One label line's coordinates -> "0 cx cy w h". A box has 4 numbers; a segmentation
    polygon has x y pairs, boxed by its extremes."""
    v = [float(p) for p in parts]
    if len(v) == 4:
        cx, cy, w, h = v
    elif len(v) >= 6 and len(v) % 2 == 0:
        xs, ys = v[0::2], v[1::2]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        w, h = max(xs) - min(xs), max(ys) - min(ys)
    else:
        return None
    if w <= 0 or h <= 0:
        return None
    return f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


def label_for(image: Path) -> Path:
    """images/x.jpg -> labels/x.txt, Roboflow's and Ultralytics' layout."""
    return image.parent.parent / "labels" / f"{image.stem}.txt"


ours = Path(args.ours).expanduser()
if not (ours / "images/train").is_dir():
    sys.exit(f"No dataset at {ours}. Run tools/export_yolo.py first.")
out = Path(args.out).expanduser()
if out.exists():
    shutil.rmtree(out)                               # a merged set is always rebuilt whole
for d in ("images/train", "images/val", "labels/train", "labels/val"):
    (out / d).mkdir(parents=True)

# Outside: read every image, keep the ones with at least one ball.
pool = []                                            # (image, label lines, source tag)
for src in map(lambda p: Path(p).expanduser(), args.outside):
    if not (src / "data.yaml").exists():
        sys.exit(f"{src} has no data.yaml. Point at the folder Roboflow's YOLOv8 export unzips to.")
    names = class_names(src)
    ball_ids = {i for i, n in enumerate(names) if is_ball(n)}
    print(f"{src.name}: balls = {[names[i] for i in sorted(ball_ids)]}")
    print(f"{' ' * len(src.name)}  dropped = {[n for i, n in enumerate(names) if i not in ball_ids]}")
    tag = re.sub(r"\W+", "-", src.name).strip("-") or "outside"
    images = sorted(p for p in src.glob("*/images/*") if p.suffix.lower() in EXTENSIONS)
    no_balls = 0
    for img in images:
        lab = label_for(img)
        lines = []
        if lab.exists():
            for row in lab.read_text().split("\n"):
                parts = row.split()
                if len(parts) >= 5 and int(float(parts[0])) in ball_ids:
                    box = to_box(parts[1:])
                    if box:
                        lines.append(box)
        if lines:
            pool.append((img, lines, tag))
        else:
            no_balls += 1
    print(f"{' ' * len(src.name)}  {len(images)} images, {len(images) - no_balls} with balls")

random.Random(args.seed).shuffle(pool)
picked = pool[:args.cap]
for n, (img, lines, tag) in enumerate(picked):
    stem = f"{tag}_{n:05d}"                          # sources can share file names
    shutil.copy(img, out / "images/train" / f"{stem}{img.suffix.lower()}")
    (out / "labels/train" / f"{stem}.txt").write_text("\n".join(lines) + "\n")

# Ours: training photos repeated, validation as is.
ours_train = 0
for img in sorted((ours / "images/train").iterdir()):
    lab = label_for(img)
    for r in range(args.repeat_ours):
        stem = f"ours_{img.stem}_{r}"
        shutil.copy(img, out / "images/train" / f"{stem}{img.suffix}")
        if lab.exists():
            shutil.copy(lab, out / "labels/train" / f"{stem}.txt")
    ours_train += 1
ours_val = 0
for img in sorted((ours / "images/val").iterdir()):
    shutil.copy(img, out / "images/val" / img.name)
    if label_for(img).exists():
        shutil.copy(label_for(img), out / "labels/val" / f"{img.stem}.txt")
    ours_val += 1

(out / "dataset.yaml").write_text(
    f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n")
print(f"\nMerged into {out.resolve()}:")
print(f"  train: {len(picked)} outside (of {len(pool)} with balls) + {ours_train} ours x{args.repeat_ours}"
      f" = {len(picked) + ours_train * args.repeat_ours} images")
print(f"  val:   {ours_val} ours")
print(f"Train with: python tools/train_yolo.py --data {out / 'dataset.yaml'}")

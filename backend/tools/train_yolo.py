"""
Train the YOLOv8n ball detector on the set tools/export_yolo.py made, then export it to
ONNX for vision.yolo_balls. Needs the training extras (PyTorch, about 1 GB), which the
server doesn't:
    pip install -r requirements-train.txt
    python tools/train_yolo.py                       -> models/balls.onnx
    python tools/train_yolo.py --epochs 150 --device cpu
    python tools/train_yolo.py --data yolo/merged/dataset.yaml --epochs 50
                                                     (with an outside set, tools/merge_yolo.py)

Then set BALL_DETECTOR=yolo in .env. Starts from the COCO-pretrained yolov8n weights
(Ultralytics downloads them, ~6 MB, on first run). Runs go to yolo/runs/balls; the
val mAP50 it prints at the end is the number to watch (how many balls it finds).
On a laptop: Apple GPU ("mps") ~15-40 min for ~60 photos at 100 epochs; CPU is slower.
"""
import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from vision import YOLO_MODEL, YOLO_SIZE  # noqa: E402

try:
    import torch
    from ultralytics import YOLO
except ImportError:
    sys.exit("Training needs the extras: pip install -r requirements-train.txt")


def best_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


ap = argparse.ArgumentParser()
ap.add_argument("--data", default=str(ROOT / "yolo/dataset/dataset.yaml"))
ap.add_argument("--epochs", type=int, default=100)
ap.add_argument("--batch", type=int, default=8, help="lower it if you run out of memory")
ap.add_argument("--device", default=None, help="mps, cpu or a CUDA index (default: best available)")
args = ap.parse_args()
if not Path(args.data).exists():
    sys.exit(f"No dataset at {args.data}. Run tools/export_yolo.py first.")

model = YOLO("yolov8n.pt")
model.train(
    data=args.data,
    imgsz=YOLO_SIZE,          # balls are small: the live crop is fed at this size too
    epochs=args.epochs,
    batch=args.batch,
    device=args.device or best_device(),
    patience=30,              # stop early once val stops improving
    single_cls=True,
    flipud=0.5,               # a table looks the same upside down; fliplr is on by default
    degrees=5.0,              # phones aren't held level
    project=str(ROOT / "yolo/runs"),
    name="balls",
    exist_ok=True,
)

best = Path(model.trainer.save_dir) / "weights" / "best.pt"
# Fixed input size and an old opset so OpenCV's ONNX loader (cv2.dnn) can read it.
onnx = Path(YOLO(str(best)).export(format="onnx", imgsz=YOLO_SIZE, opset=12, dynamic=False, simplify=True))
YOLO_MODEL.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(onnx, YOLO_MODEL)
print(f"\nModel ready: {YOLO_MODEL}\nTurn it on with BALL_DETECTOR=yolo in .env "
      "(run tools/debug_vision.py on a few photos first to compare).")

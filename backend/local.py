"""
PocketIQ in the browser: what the app calls instead of a server. It runs in the app's
worker (frontend/src/engine/worker.ts) on Pyodide, with game.py, physics.py and vision.py
as they are.

The app keeps each game's state (the same dict as ever) and sends it with every call; what
comes back is the new state to keep. Everything crosses over as JSON.

Reading a photo takes a few steps, because the neural network runs in JavaScript (ONNX
Runtime): start_photo finds the table, photo_input gives the network its inputs one at a
time, finish_photo gets the outputs.
"""
import copy
import json

import game
import physics

TABLE = {"width": physics.TABLE_W, "height": physics.TABLE_H}


def call(name: str, args: str) -> str:
    """One request. Answers {"result": ...} or {"error": message for the player}."""
    try:
        return json.dumps({"result": _CALLS[name](**json.loads(args))})
    except game.GameError as e:
        return json.dumps({"error": str(e)})


def _load(record: dict) -> dict:
    """The game's state, or a new one: the app makes games itself, with just an id and names."""
    if record["state"] is not None:
        return record["state"]
    return {**game.new_game(record["players"]), "_id": record["id"]}


def _view(result: dict, state: dict) -> dict:
    return {
        "table": TABLE,
        "ball_radius": physics.R,
        "balls": result["balls"],
        "missing": result["missing"],
        "rejected": result["rejected"],
        "revived": result.get("revived", []),
        "shot": result.get("shot"),
        "game": game.public(state),
    }


def _layout(record: dict, balls: list[dict], intended: dict | None, new: bool) -> dict:
    """The player confirmed a layout. `new`: it's the photo they just took (previewed, not
    saved yet). Otherwise it fixes the latest photo, or confirms a retake of it: the game
    rewinds to before that photo and replays it."""
    state = _load(record)
    apply = game.process_photo if new else game.replace_photo
    result = apply(state, balls, corrected=True, intended=intended)
    return {"state": state, "view": _view(result, state)}


def _turn(record: dict, turn: int) -> dict:
    state = _load(record)
    game.set_turn(state, turn)
    return {"state": state, "game": game.public(state)}


def _pocketed(record: dict, pocketed: list[dict], balls: list[dict] | None) -> dict:
    state = _load(record)
    seen = game.set_gutter(state, pocketed, balls)
    return {"state": state, "view": _view({**seen, "shot": None}, state)}


def _plan(balls: list[dict], group: str | None, target_id: int, pocket: str, kind: str,
          cut_angle: float | None = None) -> dict:
    """The best power and spin for this shot: pockets it, no scratch, easiest next shot."""
    if not any(b["type"] == "cue" for b in balls):
        raise game.GameError("There's no cue ball in this layout.")
    shot = physics.match_shot(balls, group, target_id, pocket, kind, cut_angle)
    if shot is None:
        raise game.GameError("That shot isn't open from this layout.")
    p = physics.plan(balls, shot, group)
    if p is None:
        return {"physics": None, "speed": None, "spin_name": None, "reason": physics.why_not(balls, shot)}
    return {"physics": physics.plan_json(p), "speed": physics.speed_word(p.power),
            "spin_name": physics.spin_word(p.spin), "reason": None}


_CALLS = {"layout": _layout, "turn": _turn, "pocketed": _pocketed, "plan": _plan}


# ------------------------------------------------------------------ photos
class _Recorder:
    """Stands in for the network: notes the inputs vision makes, finds nothing."""
    def __init__(self):
        self.inputs = []

    def setInput(self, blob):
        self.inputs.append(blob)

    def forward(self):
        import numpy as np
        return np.zeros((1, 5, 1), np.float32)


class _Replay:
    """Stands in for the network: hands back the outputs JavaScript got, in order."""
    def __init__(self, outputs):
        self.outputs = list(outputs)

    def setInput(self, blob):
        pass

    def forward(self):
        return self.outputs.pop(0)


_photo: dict = {}
_find_table = None      # vision.table_homography itself


def _buffer(js):
    return js.to_memoryview() if hasattr(js, "to_memoryview") else js


def start_photo(rgba, w: int, h: int) -> str:
    """Find the table. {"inputs": how many times to run the network} or {"error": ...}."""
    global _find_table
    import cv2
    import numpy as np
    import vision
    _find_table = _find_table or vision.table_homography
    img = cv2.cvtColor(np.frombuffer(_buffer(rgba), np.uint8).reshape(h, w, 4), cv2.COLOR_RGBA2BGR)
    try:
        H = _find_table(img)
    except vision.VisionError as e:
        return json.dumps({"error": str(e)})
    net = _Recorder()
    vision._yolo_model = lambda: net
    vision.yolo_balls(img, H)
    _photo.update(img=img, H=H, inputs=net.inputs)
    return json.dumps({"inputs": len(net.inputs), "size": vision.YOLO_SIZE})


def photo_input(i: int):
    """The i-th network input, as flat floats. Can be asked for once: it's freed after."""
    import numpy as np
    blob, _photo["inputs"][i] = _photo["inputs"][i], None
    return np.ascontiguousarray(blob, np.float32).ravel()


def finish_photo(outputs, shape, args: str) -> str:
    """Name the balls and work out the shot since the last photo. A preview: the state
    isn't returned, so nothing is saved until the player confirms (_layout)."""
    import numpy as np
    import vision
    a = json.loads(args)
    outs = [np.frombuffer(_buffer(o), np.float32).reshape(tuple(shape)).copy() for o in outputs]
    H = _photo["H"]
    vision._yolo_model = lambda: _Replay(outs)
    vision.table_homography = lambda img: H       # already found
    try:
        found = vision.analyze_image(_photo["img"]).balls
        balls = [{**b, "confidence": float(b["confidence"])} for b in found]
        trial = copy.deepcopy(_load(a["record"]))
        apply = game.replace_photo if a["retake"] else game.process_photo
        result = apply(trial, balls, intended=a["intended"])
        return json.dumps({"result": {**_view(result, trial), "pending": True}})
    except (game.GameError, vision.VisionError) as e:
        return json.dumps({"error": str(e)})
    finally:
        vision.table_homography = _find_table
        _photo.clear()

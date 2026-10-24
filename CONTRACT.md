# CueIQ data contract

Both sides code against this. Change it only together, and update
`frontend/src/types.ts` in the same commit.

## Coordinate system
- Table is always **1000 × 500** units (2:1, like a real table).
- Origin (0,0) = top-left corner of the **felt** (inside the cushions).
- x grows right, y grows down. Ball radius = 11 units.
- Vision warps every photo into this space. Physics and drawing only ever use it.

## POST /analyze
Request: `multipart/form-data`, field `photo` = JPEG/PNG.

Response:
```json
{
  "table": {"width": 1000, "height": 500},
  "ball_radius": 11,
  "balls": [
    {"id": null, "type": "cue",    "x": 250, "y": 250, "confidence": 0.99},
    {"id": 8,    "type": "eight",  "x": 700, "y": 250, "confidence": 0.95},
    {"id": 10,   "type": "stripe", "x": 760, "y": 300, "confidence": 0.60}
  ]
}
```
- `type`: `"cue" | "eight" | "solid" | "stripe"`
- `id`: 1–15, or `null` for the cue ball / when the number isn't readable
- `confidence` < 0.7 → frontend flags the ball for the user to confirm

Errors: `{"detail": "human-readable message"}` with HTTP 400 (not an image) or
422 (the photo can't be used: table not found, cut off, ...). Show `detail` to the user.

## Games (8-ball, two players)
The backend remembers each game in Tiger Data (Postgres): which balls are still in play,
groups, whose turn it is. That memory is authoritative; detections are checked against it.
Every shot is also stored for good, which is how the coach knows each player's strengths.

**Shots are detected from photos; nobody types in what went in.** The flow is: photo,
shoot, photo, shoot... Take each photo once the balls stop, before anyone touches them.
Each photo is compared with the previous one:
- a ball seen in the previous photo and gone now → pocketed
- the cue ball seen in the previous photo and gone now → scratch
- nothing pocketed and nothing moved → no shot taken (a retake); the turn doesn't change
- a ball not seen in EITHER photo stays in play (probably hidden, not pocketed)
- a detection that looks like a pocketed ball is matched to a ball still in play, or
  rejected, unless vision is sure of its number and nothing in play explains it: then
  that ball was only missed in an earlier photo. It comes back (`revived`), and the shot
  that "pocketed" it is corrected (its event gets `"revived": [n]`, and `pocketed` loses n)

**The first photo is the racked table** (all 15 balls in the rack plus the cue ball, the
whole table in frame, like every other photo). No separate close-up of the rack is
needed. The next shot is the break: the table stays open whatever goes in, and an 8 made
on the break is spotted (`"spotted": [8]` in the event; put it back on the foot spot
before the next photo).

**Scratch → ball in hand.** After a scratch, `Game.ball_in_hand` is true: the next
player places the cue ball anywhere. Ask the coach (`/advice`, which then says where to
place it) or `POST /plan/ball-in-hand`. It goes back to false once a photo shows the cue
ball on the table, or the next shot is played. Shooting straight from hand without a
photo in between is fine; if the cue ball is still missing after that shot, it's
another scratch.

Mistakes are fixed by correcting the latest photo's layout (`PUT /games/{id}/layout`) or
retaking it: the game rewinds to just before that photo and replays it, so the shot it
showed (what went in, scratch, groups, turn, winner) is recomputed. Only the latest
photo can be corrected.

Positions and ball types come from OpenCV. Optionally (`GEMINI_BALL_ID=on`, off by
default because it's slow) Gemini double-checks which number each ball is.

`Game` (returned by every game endpoint):
```json
{
  "id": "3f9c1a2b7d4e",
  "players": [{"name": "Ana", "group": "solid"}, {"name": "Ben", "group": "stripe"}],
  "turn": 0,
  "winner": null,
  "ball_in_hand": false,
  "balls": {"cue": "on", "1": "on", "2": "sunk", "...": "...", "15": "on"},
  "history": [{"t": 1761300000.0, "player": "Ana", "pocketed": [2], "scratch": false,
               "break": false, "spotted": [],
               "result": "continues", "photo": 4,
               "intended": {"target": 2, "pocket": "top_left", "kind": "direct", "cut_angle": 18},
               "made": true, "coached": true,
               "advice": {"target_ball": 2, "pocket": "top_left", "made": true}}],
  "layout": {"n": 4, "balls": [{"id": null, "type": "cue", "x": 250, "y": 250, "confidence": 0.98}],
             "intended": null}
}
```
- `turn`, `winner`: index into `players` (`winner` null while playing)
- `group`: `"solid" | "stripe" | null` (null = table still open)
- `ball_in_hand`: true after a scratch, until the cue ball is back on the table (see above)
- `result`: `"continues" | "turn passes" | "won" | "lost"`; `advice` is null if the coach wasn't asked
- `break`: this was the break shot; `spotted`: balls put back on the table ([8] if made on the break)
- `intended`: the shot they went for (null if unknown); `made`: whether its target went in
- `photo`: number of the photo that showed this shot's result
- `history`: the last 10 shots
- `layout`: the latest photo's balls (what the correction editor starts from); null
  before the first photo. `n` counts photos in this game.

`POST /games` `{"players": ["Ana", "Ben"]}` → `Game`

`GET /games/{id}` → `Game`

`POST /games/{id}/analyze`: the next photo. Multipart: `photo` (like `/analyze`), plus
optional `intended` (JSON string of the shot the player went for, e.g.
`{"target": 2, "pocket": "top_left", "kind": "direct", "cut_angle": 18}`: makes their stats
count it as made or missed) and `retake` (`"true"`: replace the latest photo instead of
following it). Returns the `/analyze` response plus:
```json
{ "missing": ["4"], "rejected": [{"type": "solid", "id": 2, "x": 10, "y": 480, "confidence": 0.4}],
  "revived": [],
  "shot": {"player": "Ana", "pocketed": [2], "scratch": false, "result": "continues", "...": "..."},
  "game": { "...": "Game" } }
```
- `balls`: only balls still in play, each with its remembered `id` and `type`
- `shot`: the shot this photo revealed (a `history` event), already applied to `game`.
  null for the first photo, or when nothing moved
- `missing`: in play but not in this photo or the previous one (hidden; still in play)
- `revived`: balls marked pocketed earlier that this photo shows on the table, now back
  in play (e.g. `[2]`). Worth a message ("the 2 is back: it was missed in an earlier photo");
  they're flagged (confidence ≤ 0.5) for the editor
- `rejected`: detections that matched no ball in play (false detections), for debugging

`PUT /games/{id}/layout`: the player corrected the latest photo (moved, relabeled, added
or removed balls). Same response as `/analyze`, with `shot` recomputed.
```json
{"balls": [{"id": null, "type": "cue", "x": 400, "y": 300},
           {"id": 9, "x": 705, "y": 250}],
 "intended": null}
```
- `balls`: EVERY ball on the table in the corrected layout. Identities are trusted as
  given. A ball left out that was in the previous photo counts as pocketed by this shot.
- `id` 1–15, or null with `"type": "cue"` for the cue ball. `x` 0–1000, `y` 0–500.
- `intended` (optional): omit to keep the one sent with the original photo
- a ball pocketed in an earlier shot can be put back: it's revived (listed in `revived`)
- 409 if a ball is listed twice, or the 8 is listed after the game ended

`POST /games/{id}/advice` → which shot to take and how, for the player whose turn it is.
Request: the top shots from `physics/shots.ts` (max 12), numbered by `index`. With ball in
hand they're ignored (they were found from the cue ball's old spot): the backend picks cue
ball spots itself, so send `{"candidates": []}`.
```json
{"candidates": [{"index": 0, "target_id": 3, "pocket": "top_left", "kind": "direct",
                 "cut_angle": 12, "difficulty": 0.21, "cue_distance": 310, "target_distance": 180}]}
```
Response:
```json
{"shot_index": 0, "target_ball": 3, "pocket": "top_left",
 "aim": "Aim at the left edge of the 3", "speed": "medium", "spin": "draw",
 "cue_ball_after": "Draw back to the middle for the 5", "why": "...", "tip": "...",
 "physics": {
   "planned": true,
   "power": 0.34,
   "spin": {"x": 0.0, "y": -0.5},
   "cue_path": [{"x": 250, "y": 250}, {"x": 412, "y": 260}, {"x": 380, "y": 310}],
   "cue_stop": {"x": 300, "y": 330},
   "object_path": [{"x": 434, "y": 262}, {"x": 0, "y": 0}],
   "scratch": false,
   "next_shot": {"target_ball": 5, "pocket": "bottom_left", "cut_angle": 14}
 },
 "ball_in_hand": null}
```
- `shot_index` -1 = no good shot: play the safety described in `aim`
- `ball_in_hand`: null normally; after a scratch `{"cue": {"x": 706, "y": 93}}`, where to
  place the cue ball. `physics` is the plan from there.
- `speed`: `"soft" | "medium" | "firm" | "hard"`;
  `spin`: `"center" | "follow" | "draw" | "stop" | "left english" | "right english"`.
  With a physics plan, these words are derived from `physics.power` / `physics.spin`,
  so they always match the indicator.
- Gemini picks and explains; `target_ball`/`pocket` always come from the chosen candidate
- `physics` (null for a safety, or if the cue ball's position is unknown): numbers for
  the spin indicator and power bar, from `backend/physics.py`. See "Spin and power" below.
- the player's stats (below) are in the prompt, so advice fits how they actually shoot
- 502 if Gemini isn't reachable or configured

`POST /games/{id}/simulate` → what happens if the current player hits a shot with a given
power and spin, from the latest layout. For moving the spin dot / power bar and showing
the result live (it's fast: a few ms).
```json
{"target_id": 3, "pocket": "top_left", "kind": "direct", "cut_angle": 12,
 "power": 0.45, "spin": {"x": 0.0, "y": 0.6}}
```
Response: the `physics` object above, minus `next_shot`, plus:
```json
{"planned": false, "made": true, "kissed": false, "speed": "firm", "spin_name": "follow", "...": "..."}
```
- `made`: the object ball drops in that pocket; `scratch`: the cue ball drops;
  `kissed`: the cue ball runs into another ball after contact (its path stops there)
- `target_id`/`pocket`/`kind`/`cut_angle`: a shot from the shot finder (the same fields as
  an advice candidate). 409 if that shot isn't open from this layout, if the cue ball
  hasn't been seen, or with ball in hand (use `/plan/ball-in-hand`)

`POST /plan` → physics only, no game: the best power and spin for one shot from any layout.
No database or Gemini, so it also works for the frontend's dev test table. The app uses it
for the spin indicator and power bar of whichever shot is selected.
```json
{"balls": [{"id": null, "type": "cue", "x": 250, "y": 250}, {"id": 12, "type": "stripe", "x": 380, "y": 140}],
 "group": null, "target_id": 12, "pocket": "top_side", "kind": "direct", "cut_angle": 11}
```
Response: `{"physics": <the advice physics object, planned: true>, "speed": "medium", "spin_name": "follow"}`.
`physics` (and the words) are null if no power and spin tried pockets the ball. 409 if
there's no cue ball or that shot isn't open from this layout.

The backend aims balls at the middle of each pocket's opening (or to one side of it, when
the middle is blocked or a ball is frozen on the rail), not at the pocket's corner point
like `shots.ts`. It also leaves out shots that can't work: banks off a pocket opening,
and balls rolled along a rail past another pocket (they drop there). So its cut angles can
differ from `shots.ts` by a few degrees, and a few `shots.ts` shots get a 409 here.
`shots.ts` could adopt the same rules (`Pocket.aims`, `_bank_in_pocket`, `_passes_pocket`
in `backend/physics.py`).

`POST /plan/ball-in-hand` → after a scratch: where to put the cue ball, and the shot and
plan from there. Physics only, like `/plan`.
```json
{"balls": [{"id": 4, "type": "solid", "x": 300, "y": 13}, {"id": 12, "type": "stripe", "x": 700, "y": 300}],
 "group": "solid"}
```
Response:
```json
{"cue": {"x": 354, "y": 18}, "target_ball": 4, "pocket": "top_left", "kind": "direct", "cut_angle": 0,
 "physics": {"...": "the advice physics object"}, "speed": "soft", "spin_name": "center"}
```
- the cue ball, if included in `balls`, is ignored (it's in hand)
- every field is null if no spot gives a makeable shot (play safe)

### Spin and power
How the numbers map to the indicator (same in advice `physics` and `/simulate`):
- `power`: 0 (barely moving) to 1 (a hard break, 8 m/s). Typical shots: 0.1–0.5.
  Words: < 0.2 soft, < 0.4 medium, < 0.65 firm, else hard.
- `spin.x`: where the cue tip hits, left (-1) to right (+1) of center: english.
- `spin.y`: below (-1, draw) to above (+1, follow) center.
- `1` = the tip half a ball-radius off center (about as far as is safe without
  miscueing). Draw it as a dot on a cue-ball circle at `(x, -y) * 0.5 * radius` from the
  center (screen y grows down, so follow is up).
- `cue_path`: the cue ball from where it starts, to contact, then after contact until it
  stops (table units, for drawing). `object_path`: the object ball to the pocket.
- `planned`: true = the backend searched power and spin for the best position play;
  false = a simulation of the coach's words, or of what was sent to `/simulate`.

The model: sliding then rolling friction, ball-ball and cushion collisions, follow/draw
bending the cue ball's path, english changing cushion rebounds. Good enough to pick
follow vs draw and soft vs firm; not to the inch (no squirt, swerve, throw).

`GET /games/{id}/advice/audio` → `audio/mpeg`: the latest advice read aloud (ElevenLabs).
409 if the coach hasn't been asked this turn; 502 if ElevenLabs fails.

`GET /players/{name}/stats` → how a player shoots, from every shot in the last 90 days:
```json
{"player": "Ana", "games": 4, "shots": 61, "attempts": 48, "made": 29,
 "make_rate": 0.6, "scratch_rate": 0.05,
 "by_cut_angle": {"0-15": {"attempts": 14, "made": 12, "rate": 0.86}, "45+": {"attempts": 9, "made": 2, "rate": 0.22}},
 "by_kind": {"direct": {"...": "..."}, "bank": {"...": "..."}},
 "by_pocket": {"corner": {"...": "..."}, "side": {"...": "..."}},
 "weekly": [{"week": "2026-10-19", "attempts": 30, "rate": 0.63}]}
```
- names match case-insensitively; `make_rate`/`scratch_rate` are null with no shots yet

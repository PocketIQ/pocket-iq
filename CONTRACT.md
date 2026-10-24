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

Every photo's detections get a second opinion from Gemini on what each ball is (and
whether it's a ball at all), unless `GEMINI_BALL_ID=off`. Positions always come from CV.

`Game` (returned by every game endpoint):
```json
{
  "id": "3f9c1a2b7d4e",
  "players": [{"name": "Ana", "group": "solid"}, {"name": "Ben", "group": "stripe"}],
  "turn": 0,
  "winner": null,
  "balls": {"cue": "on", "1": "on", "2": "sunk", "...": "...", "15": "on"},
  "history": [{"t": 1761300000.0, "player": "Ana", "pocketed": [2], "scratch": false,
               "result": "continues",
               "intended": {"target": 2, "pocket": "top_left", "kind": "direct", "cut_angle": 18},
               "made": true, "coached": true,
               "advice": {"target_ball": 2, "pocket": "top_left", "made": true}}]
}
```
- `turn`, `winner`: index into `players` (`winner` null while playing)
- `group`: `"solid" | "stripe" | null` (null = table still open)
- `result`: `"continues" | "turn passes" | "won" | "lost"`; `advice` is null if the coach wasn't asked
- `intended`: the shot they went for (null if unknown); `made`: whether its target went in
- `history`: the last 10 shots

`POST /games` `{"players": ["Ana", "Ben"]}` → `Game`

`GET /games/{id}` → `Game`

`POST /games/{id}/analyze` photo like `/analyze` → the `/analyze` response plus:
```json
{ "missing": ["4", "cue"], "rejected": [{"type": "solid", "id": 2, "x": 10, "y": 480, "confidence": 0.4}],
  "game": { "...": "Game" } }
```
- `balls`: only balls still in play, each with its remembered `id` and `type`
- `missing`: in play and seen in an earlier photo, but not in this one. NOT removed: ask
  the player if they went in (`"cue"` missing suggests a scratch)
- `rejected`: detections that matched no ball in play, or that Gemini says aren't balls
  (false detections), for debugging

`POST /games/{id}/shot` → `Game`. Records the current player's shot. 409 if it breaks the
state (ball already pocketed, game over).
```json
{"pocketed": [2, 5], "scratch": false,
 "intended": {"target": 2, "pocket": "top_left", "kind": "direct", "cut_angle": 18}}
```
- `intended` (optional): the shot the player selected in the app. Send it whenever you can:
  it's what counts a shot as made or missed in their stats. Without it, the coach's
  suggestion is used if they asked; otherwise the shot only counts toward scratches.

`POST /games/{id}/advice` → which shot to take and how, for the player whose turn it is.
Request: the top shots from `physics/shots.ts` (max 12), numbered by `index`:
```json
{"candidates": [{"index": 0, "target_id": 3, "pocket": "top_left", "kind": "direct",
                 "cut_angle": 12, "difficulty": 0.21, "cue_distance": 310, "target_distance": 180}]}
```
Response:
```json
{"shot_index": 0, "target_ball": 3, "pocket": "top_left",
 "aim": "Aim at the left edge of the 3", "speed": "medium", "spin": "draw",
 "cue_ball_after": "Draw back to the middle for the 5", "why": "...", "tip": "..."}
```
- `shot_index` -1 = no good shot: play the safety described in `aim`
- `speed`: `"soft" | "medium" | "firm" | "hard"`;
  `spin`: `"center" | "follow" | "draw" | "stop" | "left english" | "right english"`
- Gemini picks and explains; `target_ball`/`pocket` always come from the chosen candidate
- the player's stats (below) are in the prompt, so advice fits how they actually shoot
- 502 if Gemini isn't reachable or configured

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

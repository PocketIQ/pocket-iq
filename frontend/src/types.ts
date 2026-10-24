// Mirrors CONTRACT.md. If you change one, change the other.
export type BallType = 'cue' | 'eight' | 'solid' | 'stripe'

export interface Ball {
  id: number | null // 1-15, null for the cue ball or when unknown
  type: BallType
  x: number // table coords, 0..table.width
  y: number // table coords, 0..table.height
  confidence: number // 0..1
}

export interface AnalyzeResponse {
  table: { width: number; height: number }
  ball_radius: number
  balls: Ball[]
}

// ---------------------------------------------------------------- games (8-ball)
export type Group = 'solid' | 'stripe' | null // null = table still open

export interface Player {
  name: string
  group: Group
}

export interface ShotEvent {
  t: number
  player: string
  pocketed: number[]
  scratch: boolean
  result: 'continues' | 'turn passes' | 'won' | 'lost'
  intended: IntendedShot | null // the shot they went for
  made: boolean | null // whether its target went in
  coached: boolean
  photo: number // the photo that showed this shot's result
  advice: { target_ball: number | null; pocket: string | null; made: boolean } | null
}

/** One pocketed ball, in the order they went in. */
export interface GutterEntry {
  ball: number // 1-15
  by: 0 | 1 | null // index into players it counts for; null = no one (the break, or not counted)
  member: string | null // team mode: which teammate (the app sets it; the backend only knows sides)
  photo: number | null // the photo whose shot pocketed it; null = added by hand
  open: boolean // the table was still open, so it can't be the wrong group's ball
}

export interface Game {
  id: string
  players: [Player, Player]
  turn: 0 | 1
  winner: 0 | 1 | null
  balls: Record<string, 'on' | 'sunk'> // "cue", "1".."15"
  history: ShotEvent[]
  gutter: GutterEntry[]
  // The latest photo's layout (what the correction editor shows); null before the first photo
  layout: { n: number; balls: Ball[]; intended: IntendedShot | null } | null
}

export interface GameAnalyzeResponse extends AnalyzeResponse {
  missing: string[] // in play, not seen now or in the previous photo: probably hidden
  rejected: Ball[] // detections that matched no ball still in play
  shot: ShotEvent | null // the shot this photo revealed; null for the first photo or no change
  game: Game
}

/** One ball in a corrected layout: its identity is trusted as given. */
export interface LayoutBall {
  id: number | null // null = cue ball
  type?: BallType // send 'cue' for the cue ball
  x: number
  y: number
}

export interface IntendedShot {
  target: number
  pocket: string
  kind: 'direct' | 'bank'
  cut_angle: number
}

export interface Candidate {
  index: number
  target_id: number
  pocket: string
  kind: 'direct' | 'bank'
  cut_angle: number
  difficulty: number
  cue_distance: number
  target_distance: number
}

export interface Advice {
  shot_index: number // -1 = no good shot: play the safety described in `aim`
  target_ball: number | null
  pocket: string | null
  aim: string
  speed: 'soft' | 'medium' | 'firm' | 'hard'
  spin: 'center' | 'follow' | 'draw' | 'stop' | 'left english' | 'right english'
  cue_ball_after: string
  why: string
  tip: string
}

interface Rate {
  attempts: number
  made: number
  rate: number
}

export interface PlayerStats {
  player: string
  games: number
  shots: number
  attempts: number
  made: number
  make_rate: number | null
  scratch_rate: number | null
  by_cut_angle: Record<string, Rate>
  by_kind: Record<string, Rate>
  by_pocket: Record<string, Rate>
  weekly: { week: string; attempts: number; rate: number }[]
}

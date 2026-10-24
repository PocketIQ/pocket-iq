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
  advice: { target_ball: number | null; pocket: string | null; made: boolean } | null
}

export interface Game {
  id: string
  players: [Player, Player]
  turn: 0 | 1
  winner: 0 | 1 | null
  balls: Record<string, 'on' | 'sunk'> // "cue", "1".."15"
  history: ShotEvent[]
}

export interface GameAnalyzeResponse extends AnalyzeResponse {
  missing: string[] // in play but not seen: ask the player, never assume pocketed
  rejected: Ball[] // detections that matched no ball still in play
  game: Game
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

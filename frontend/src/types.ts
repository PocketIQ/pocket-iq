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
  debug?: { received_bytes: number; image_size: [number, number] }
}

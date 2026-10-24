import type { Advice } from './types'

/** Where to hit the cue ball and how hard. */
export interface Guide {
  // Contact point on the cue ball's face, -1..1 from center: x right, y down (follow is negative y).
  spin: { x: number; y: number }
  power: number // 0 = softest, 1 = hardest
  label: string
  example: boolean // test values, not from the coach
}

const SPIN: Record<Advice['spin'], { x: number; y: number }> = {
  center: { x: 0, y: 0 },
  follow: { x: 0, y: -0.6 },
  draw: { x: 0, y: 0.6 },
  stop: { x: 0, y: 0.25 },
  'left english': { x: -0.6, y: 0 },
  'right english': { x: 0.6, y: 0 },
}

const POWER: Record<Advice['speed'], number> = {
  soft: 0.2,
  medium: 0.45,
  firm: 0.7,
  hard: 0.9,
}

export function guideFromAdvice(advice: Advice): Guide {
  return {
    spin: SPIN[advice.spin] ?? SPIN.center,
    power: POWER[advice.speed] ?? POWER.medium,
    label: `${advice.spin} · ${advice.speed}`,
    example: false,
  }
}

// Shown until the coach has answered (or when it can't): placeholder values.
export const TEST_GUIDE: Guide = {
  spin: { x: 0.2, y: -0.35 },
  power: 0.55,
  label: 'example',
  example: true,
}

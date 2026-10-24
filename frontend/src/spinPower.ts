import type { Advice } from './types'

/** Where to hit the cue ball and how hard. */
export interface Guide {
  // Contact point, CONTRACT.md "Spin and power": -1..1, x right (english), y up (follow).
  // 1 = half a ball radius off center, about as far as is safe without miscueing.
  spin: { x: number; y: number }
  power: number // 0 = barely moving, 1 = a hard break
  label: string
  placeholder: boolean // not real advice: drawn faded
}

// Fallback when the coach gave words but no physics plan (e.g. a safety).
const SPIN: Record<Advice['spin'], { x: number; y: number }> = {
  center: { x: 0, y: 0 },
  follow: { x: 0, y: 0.6 },
  draw: { x: 0, y: -0.6 },
  stop: { x: 0, y: -0.25 },
  'left english': { x: -0.6, y: 0 },
  'right english': { x: 0.6, y: 0 },
}

// Middle of each word's band in the backend's thresholds (0.2 / 0.4 / 0.65).
const POWER: Record<Advice['speed'], number> = {
  soft: 0.12,
  medium: 0.3,
  firm: 0.52,
  hard: 0.8,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function guideFromAdvice(advice: Advice): Guide {
  const label = `${advice.spin} · ${advice.speed}`
  // The backend's numbers when it planned the shot; its words always match them.
  if (advice.physics) {
    const { spin, power } = advice.physics
    return {
      spin: { x: clamp(spin.x, -1, 1), y: clamp(spin.y, -1, 1) },
      power: clamp(power, 0, 1),
      label,
      placeholder: false,
    }
  }
  return { spin: SPIN[advice.spin] ?? SPIN.center, power: POWER[advice.speed] ?? POWER.medium, label, placeholder: false }
}

/** Shown while the coach is thinking, or if it couldn't answer. */
export const waitingGuide = (label: string): Guide => ({ spin: { x: 0, y: 0 }, power: 0.3, label, placeholder: true })

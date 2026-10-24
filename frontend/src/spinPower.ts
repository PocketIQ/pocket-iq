import type { PlanResponse } from './api'

/** Where to hit the cue ball and how hard. */
export interface Guide {
  // Contact point, CONTRACT.md "Spin and power": -1..1, x right (english), y up (follow).
  // 1 = half a ball radius off center, about as far as is safe without miscueing.
  spin: { x: number; y: number }
  power: number // 0 = barely moving, 1 = a hard break
  label: string
  placeholder: boolean // not a physics plan: drawn faded
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The physics engine's plan for the selected shot (POST /plan). */
export function guideFromPlan(plan: PlanResponse): Guide {
  if (!plan.physics) return placeholderGuide('No safe power found')
  const { spin, power } = plan.physics
  return {
    spin: { x: clamp(spin.x, -1, 1), y: clamp(spin.y, -1, 1) },
    power: clamp(power, 0, 1),
    label: `${plan.spin_name} · ${plan.speed}`,
    placeholder: false,
  }
}

/** Shown while planning, or when there's no plan. */
export const placeholderGuide = (label: string): Guide => ({ spin: { x: 0, y: 0 }, power: 0.3, label, placeholder: true })

/**
 * Shot finder. Pure geometry, no React — everything is in table units (CONTRACT.md).
 *
 * Core idea (the "ghost ball"): to send an object ball toward a pocket, the cue ball
 * must be touching it at impact on the side directly opposite the pocket. That spot
 * is 2 radii behind the object ball along the pocket→ball line. Aim the cue ball's
 * center there and the object ball goes to the pocket.
 */
import type { Ball } from '../types'

export type Vec = { x: number; y: number }
export type Group = 'solid' | 'stripe' | null // null = table still open

export interface Pocket { name: string; x: number; y: number; side: boolean }

export interface Shot {
  targetId: number | null
  targetIndex: number   // index into the balls array (ids can be null or duplicated)
  pocket: string
  kind: 'direct' | 'bank'
  ghost: Vec            // where the cue ball's center is at impact
  cuePath: Vec[]        // cue -> ghost
  targetPath: Vec[]     // target -> (bank point ->) pocket
  bankPoint: Vec | null
  cutAngle: number      // degrees; 0 = straight in
  difficulty: number    // 0 easy .. 1+ hard; sort ascending
}

// --------------------------------------------------------------- vector basics
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k })
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y
const len = (a: Vec) => Math.hypot(a.x, a.y)
const unit = (a: Vec) => mul(a, 1 / (len(a) || 1))

/** Shortest distance from point p to the segment a→b. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a)
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)))
  return len(sub(p, add(a, mul(ab, t)))) // closest point on segment is a + t·ab
}

/**
 * A moving ball of radius r collides with a resting ball if the resting ball's center
 * comes within 2r of the moving ball's center line. So: is any other ball within 2r
 * of the segment?
 */
function pathClear(a: Vec, b: Vec, balls: Ball[], skip: Set<number>, r: number): boolean {
  return balls.every((ball, i) => skip.has(i) || distToSegment(ball, a, b) >= 2 * r)
}

export function pocketsFor(W: number, H: number): Pocket[] {
  return [
    { name: 'top_left', x: 0, y: 0, side: false },
    { name: 'top_side', x: W / 2, y: 0, side: true },
    { name: 'top_right', x: W, y: 0, side: false },
    { name: 'bottom_left', x: 0, y: H, side: false },
    { name: 'bottom_side', x: W / 2, y: H, side: true },
    { name: 'bottom_right', x: W, y: H, side: false },
  ]
}

/** Angle in degrees between the cue's travel direction and the target's travel direction. */
function cutAngleDeg(cue: Vec, ghost: Vec, target: Vec, aimAt: Vec): number {
  const c = dot(unit(sub(ghost, cue)), unit(sub(aimAt, target)))
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI
}

/** Which balls am I allowed to hit first? */
function legalTargets(balls: Ball[], group: Group): number[] {
  const idx = balls.map((_, i) => i)
  if (group === null) return idx.filter(i => balls[i].type === 'solid' || balls[i].type === 'stripe')
  const mine = idx.filter(i => balls[i].type === group)
  return mine.length ? mine : idx.filter(i => balls[i].type === 'eight') // group cleared → 8-ball
}

// --------------------------------------------------------------- shot search
export function findShots(
  balls: Ball[],
  table: { width: number; height: number },
  r: number,
  group: Group,
): Shot[] {
  const cueIndex = balls.findIndex(b => b.type === 'cue')
  if (cueIndex < 0) return []
  const cue = balls[cueIndex]
  const W = table.width, H = table.height
  const diag = Math.hypot(W, H)
  const pockets = pocketsFor(W, H)
  const shots: Shot[] = []

  for (const ti of legalTargets(balls, group)) {
    const target = balls[ti]

    for (const pocket of pockets) {
      // ---------- direct: target straight to pocket
      tryShot(ti, target, pocket, pocket, null)

      // ---------- one-cushion bank
      // A ball's CENTER bounces off a line r inside the cushion. Bounce angle in = angle
      // out, which is the same as aiming in a straight line at the pocket's mirror image
      // across that line. Where that line crosses the cushion is the bank point.
      const cushions = [
        { mirror: (p: Vec) => ({ x: p.x, y: 2 * r - p.y }), hit: (a: Vec, b: Vec) => crossY(a, b, r) },
        { mirror: (p: Vec) => ({ x: p.x, y: 2 * (H - r) - p.y }), hit: (a: Vec, b: Vec) => crossY(a, b, H - r) },
        { mirror: (p: Vec) => ({ x: 2 * r - p.x, y: p.y }), hit: (a: Vec, b: Vec) => crossX(a, b, r) },
        { mirror: (p: Vec) => ({ x: 2 * (W - r) - p.x, y: p.y }), hit: (a: Vec, b: Vec) => crossX(a, b, W - r) },
      ]
      for (const c of cushions) {
        const mirrored = c.mirror(pocket)
        if (len(sub(mirrored, pocket)) < 4 * r) continue // pocket sits on this cushion
        const bank = c.hit(target, mirrored)
        if (!bank || bank.x < r || bank.x > W - r || bank.y < r || bank.y > H - r) continue
        tryShot(ti, target, pocket, mirrored, bank)
      }
    }
  }

  function tryShot(ti: number, target: Ball, pocket: Pocket, aimAt: Vec, bank: Vec | null) {
    const ghost = sub(target, mul(unit(sub(aimAt, target)), 2 * r))
    if (ghost.x < r || ghost.x > W - r || ghost.y < r || ghost.y > H - r) return

    const cut = cutAngleDeg(cue, ghost, target, aimAt)
    if (cut > 75) return // thinner than this is basically unmakeable

    // Side pockets only accept balls coming in fairly straight.
    const finalLeg = bank ? sub(pocket, bank) : sub(pocket, target)
    if (pocket.side && Math.abs(unit(finalLeg).y) < 0.5) return

    const skipCue = new Set([cueIndex, ti])
    const skipTarget = new Set([ti, cueIndex])
    if (!pathClear(cue, ghost, balls, skipCue, r)) return
    if (bank) {
      if (!pathClear(target, bank, balls, skipTarget, r)) return
      if (!pathClear(bank, pocket, balls, skipTarget, r)) return
    } else if (!pathClear(target, pocket, balls, skipTarget, r)) return

    const travel = len(sub(ghost, cue)) + (bank ? len(sub(bank, target)) + len(sub(pocket, bank)) : len(sub(pocket, target)))
    const difficulty =
      0.55 * (cut / 75) ** 1.5 +      // thin cuts are disproportionately hard
      0.3 * (travel / diag) +         // longer = harder
      (bank ? 0.25 : 0) +             // banks add error
      (pocket.side ? 0.05 : 0)

    shots.push({
      targetId: target.id,
      targetIndex: ti,
      pocket: pocket.name,
      kind: bank ? 'bank' : 'direct',
      ghost,
      cuePath: [cue, ghost],
      targetPath: bank ? [target, bank, pocket] : [target, pocket],
      bankPoint: bank,
      cutAngle: Math.round(cut),
      difficulty: Math.round(difficulty * 100) / 100,
    })
  }

  return shots.sort((a, b) => a.difficulty - b.difficulty)
}

/** Point where segment a→b crosses the horizontal line y = Y (or null). */
function crossY(a: Vec, b: Vec, Y: number): Vec | null {
  if ((a.y - Y) * (b.y - Y) > 0 || a.y === b.y) return null
  const t = (Y - a.y) / (b.y - a.y)
  return { x: a.x + t * (b.x - a.x), y: Y }
}
function crossX(a: Vec, b: Vec, X: number): Vec | null {
  if ((a.x - X) * (b.x - X) > 0 || a.x === b.x) return null
  const t = (X - a.x) / (b.x - a.x)
  return { x: X, y: a.y + t * (b.y - a.y) }
}

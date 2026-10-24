import { sideOf } from './teams'
import type { Game } from './types'

/** One pocketed ball in the gutter. */
export interface GutterBall {
  ball: number // 1-15
  side: 0 | 1 | null // whose ring it gets; null = no ring (on the break, or not counted)
  member: string | null // team mode: which teammate pocketed it
  wrong: boolean // the shooter pocketed the other side's ball
}

/** The player's fixes to what was detected, kept per game in this browser. */
export interface GutterEdits {
  set: Record<number, { side: 0 | 1 | null; member: string | null }>
  removed: number[]
  added: number[]
}

export const NO_EDITS: GutterEdits = { set: {}, removed: [], added: [] }

const ballGroup = (n: number) => (n === 8 ? null : n < 8 ? 'solid' : 'stripe')

/** Did `side` pocket the other side's ball? Only once groups are decided. */
export function isWrong(game: Game, side: 0 | 1 | null, ball: number): boolean {
  if (side == null) return false
  const group = game.players[side].group
  const g = ballGroup(ball)
  return group != null && g != null && g !== group
}

/**
 * Pocketed balls in the order they went in, from the game's shot history:
 * - the break (the shot the second photo revealed) gets no ring
 * - otherwise the shooter's ring, dashed if it was the other side's ball. A shot on an
 *   open table that decides the groups is never "wrong".
 * Pocketed balls older than the history (it keeps the last 10 shots) go first, unringed.
 */
export function deriveGutter(game: Game, byShot: (string | null)[]): GutterBall[] {
  const out: GutterBall[] = []
  let groupsSet = false
  game.history.forEach((ev, i) => {
    const isBreak = ev.photo === 2
    const side = isBreak ? null : sideOf(game, ev.player)
    for (const ball of ev.pocketed) {
      out.push({ ball, side, member: side == null ? null : byShot[i], wrong: groupsSet && isWrong(game, side, ball) })
    }
    if (!isBreak && ev.pocketed.some(b => b !== 8)) groupsSet = true
  })
  const listed = new Set(out.map(g => g.ball))
  const older = Object.entries(game.balls)
    .filter(([b, s]) => s === 'sunk' && b !== 'cue' && !listed.has(Number(b)))
    .map(([b]) => ({ ball: Number(b), side: null, member: null, wrong: false }))
  return [...older, ...out]
}

export function applyEdits(game: Game, derived: GutterBall[], edits: GutterEdits): GutterBall[] {
  const removed = new Set(edits.removed)
  const balls = derived.filter(g => !removed.has(g.ball))
  for (const ball of edits.added) {
    if (!removed.has(ball) && !balls.some(g => g.ball === ball)) balls.push({ ball, side: null, member: null, wrong: false })
  }
  return balls.map(g => {
    const fix = edits.set[g.ball]
    return fix ? { ...g, ...fix, wrong: isWrong(game, fix.side, g.ball) } : g
  })
}

const editsKey = (gameId: string) => `cueiq.gutter.${gameId}`

export function loadEdits(gameId: string): GutterEdits {
  try {
    const raw = localStorage.getItem(editsKey(gameId))
    return raw ? { ...NO_EDITS, ...(JSON.parse(raw) as GutterEdits) } : NO_EDITS
  } catch {
    return NO_EDITS
  }
}

export function saveEdits(gameId: string, edits: GutterEdits) {
  try {
    localStorage.setItem(editsKey(gameId), JSON.stringify(edits))
  } catch {
    /* storage blocked: fixes just won't survive a reload */
  }
}

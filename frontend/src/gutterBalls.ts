import type { Game, GutterEntry } from './types'

/** One pocketed ball as the gutter shows it. */
export interface GutterBall {
  ball: number // 1-15
  side: 0 | 1 | null // whose ring it gets; null = no ring (on the break, or not counted)
  member: string | null // team mode: which teammate pocketed it
  wrong: boolean // the shooter pocketed the other side's ball
}

const ballGroup = (n: number) => (n === 8 ? null : n < 8 ? 'solid' : 'stripe')

/** Did `side` pocket the other side's ball? Only once groups are decided. */
export function isWrong(game: Game, side: 0 | 1 | null, ball: number): boolean {
  if (side == null) return false
  const group = game.players[side].group
  const g = ballGroup(ball)
  return group != null && g != null && g !== group
}

/**
 * The game's gutter (kept by the backend) ready to draw. In team mode, a ball nobody has
 * assigned a teammate to gets whoever took the shot that pocketed it (`byShot`, one per
 * history event). A ball pocketed while the table was open is never "wrong".
 */
export function gutterView(game: Game, byShot: (string | null)[]): GutterBall[] {
  return game.gutter.map(e => {
    const shot = game.history.findIndex(ev => ev.photo === e.photo)
    return {
      ball: e.ball,
      side: e.by,
      member: e.by == null ? null : e.member ?? (shot >= 0 ? byShot[shot] : null),
      wrong: !e.open && isWrong(game, e.by, e.ball),
    }
  })
}

/** What the backend does with a gutter fix, for the test table (which has no backend). */
export function withGutter(game: Game, gutter: GutterEntry[]): Game {
  const sunk = new Set(gutter.map(e => String(e.ball)))
  const balls = Object.fromEntries(
    Object.keys(game.balls).map(b => [b, b !== 'cue' && sunk.has(b) ? 'sunk' : 'on'] as const),
  )
  return { ...game, gutter, balls }
}

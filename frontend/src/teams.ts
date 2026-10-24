import type { Game } from './types'

/**
 * Team mode is frontend-only: the backend's two "players" are the two teams (named after
 * them), and who's on each team lives here. null = a normal 1 vs 1 game.
 */
export type Rosters = [string[], string[]] | null

/** Ring color for each side, used on the scoreboard and around pocketed balls. */
export const SIDE_COLORS = ['#38bdf8', '#fb923c'] as const

const rosterKey = (gameId: string) => `cueiq.teams.${gameId}`

export function loadRosters(gameId: string): Rosters {
  try {
    const raw = localStorage.getItem(rosterKey(gameId))
    return raw ? (JSON.parse(raw) as Rosters) : null
  } catch {
    return null
  }
}

export function saveRosters(gameId: string, rosters: Rosters) {
  try {
    if (rosters) localStorage.setItem(rosterKey(gameId), JSON.stringify(rosters))
    else localStorage.removeItem(rosterKey(gameId))
  } catch {
    /* storage blocked: teammates just won't survive a reload */
  }
}

export function sideOf(game: Game, player: string): 0 | 1 | null {
  const i = game.players.findIndex(p => p.name === player)
  return i === 0 || i === 1 ? i : null
}

/**
 * Which teammate took each shot in the game's history, and who's up now. Teammates take
 * turns in roster order: each time a team comes back to the table, the next one shoots.
 * Shots the history no longer has (it keeps the last 10) can throw this off; the gutter
 * editor fixes individual balls.
 */
export function teamTurns(game: Game, rosters: Rosters): { byShot: (string | null)[]; up: string | null } {
  if (!rosters) return { byShot: game.history.map(() => null), up: null }
  const visits = [0, 0]
  let last: 0 | 1 | null = null
  const member = (side: 0 | 1, visit: number) => rosters[side][(visit - 1) % rosters[side].length] ?? null
  const byShot = game.history.map(ev => {
    const side = sideOf(game, ev.player)
    if (side == null) return null
    if (side !== last) visits[side]++
    last = side
    return member(side, visits[side])
  })
  const turn = game.turn
  const up = member(turn, last === turn ? visits[turn] : visits[turn] + 1)
  return { byShot, up }
}

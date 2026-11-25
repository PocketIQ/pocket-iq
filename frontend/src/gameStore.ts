/**
 * Games saved on this phone. Each keeps the whole state backend/game.py works on, and the
 * public Game the app shows, so a saved game opens without waiting for Python.
 */
import type { Game } from './types'

export interface GameRecord {
  id: string
  players: [string, string]
  state: unknown // game.py's own; null until the first photo, fix or turn
  game: Game
  saved: number // ms since 1970
}

const PREFIX = 'pocketiq.game.'
const KEEP = 20 // older games are dropped

// Storage can be blocked or full: the game then lasts until the page closes
const memory = new Map<string, GameRecord>()

function newBalls(): Game['balls'] {
  return Object.fromEntries(['cue', ...Array.from({ length: 15 }, (_, i) => String(i + 1))].map(b => [b, 'on']))
}

export function newRecord(names: [string, string]): GameRecord {
  const players = names.map(n => n.trim()) as [string, string]
  if (players.some(n => !n)) throw new Error('Both players need a name.')
  if (players[0].toLowerCase() === players[1].toLowerCase()) throw new Error('Players need different names.')
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')
  return {
    id,
    players,
    state: null,
    game: {
      id,
      players: [{ name: players[0], group: null }, { name: players[1], group: null }],
      turn: 0,
      winner: null,
      balls: newBalls(),
      history: [],
      gutter: [],
      layout: null,
    },
    saved: Date.now(),
  }
}

/** The saved game, or null if this phone doesn't have it. */
export function loadRecord(id: string): GameRecord | null {
  const kept = memory.get(id)
  if (kept) return kept
  try {
    const text = localStorage.getItem(PREFIX + id)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function dropOldest() {
  const saved = Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(k => {
    let at = 0
    try {
      at = JSON.parse(localStorage.getItem(k) ?? '').saved
    } catch {
      /* unreadable: the first to go */
    }
    return { k, at }
  })
  saved.sort((a, b) => b.at - a.at)
  for (const { k } of saved.slice(KEEP)) localStorage.removeItem(k)
}

export function saveRecord(record: GameRecord) {
  const now = { ...record, saved: Date.now() }
  memory.set(record.id, now)
  try {
    localStorage.setItem(PREFIX + record.id, JSON.stringify(now))
    dropOldest()
  } catch {
    /* kept in memory */
  }
}

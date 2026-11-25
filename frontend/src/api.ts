// What the app asks of the game. There's no server: saved games are in gameStore.ts, and
// the rules, physics and photo reading run on the phone (engine/, backend/local.py).
import { call, readPhoto } from './engine/engine'
import { loadRecord, newRecord, saveRecord, type GameRecord } from './gameStore'
import type { Game, GameAnalyzeResponse, GutterEntry, IntendedShot, LayoutBall, ShotPhysics } from './types'

function record(id: string): GameRecord {
  const r = loadRecord(id)
  if (!r) throw new Error('That game isn’t on this phone. Start a new one.')
  return r
}

/** What Python needs of a game. */
const sent = ({ id, players, state }: GameRecord) => ({ id, players, state })

export function createGame(players: [string, string]): Game {
  const r = newRecord(players)
  saveRecord(r)
  return r.game
}

/** A saved game, or null if this phone doesn't have it. */
export const getGame = (id: string): Game | null => loadRecord(id)?.game ?? null

/**
 * The next photo of the table. It's compared with the previous one to work out the shot in
 * between (what went in, scratch), but nothing is saved: the response is a preview
 * (`pending`), saved by correctLayout once the player confirms it. `intended`: the shot the
 * player went for. `retake`: replace the latest photo instead of following it.
 */
export const analyzeGamePhoto = async (
  id: string,
  photo: ImageData,
  { intended = null, retake = false }: { intended?: IntendedShot | null; retake?: boolean } = {},
) => readPhoto<GameAnalyzeResponse>(photo, { record: sent(record(id)), intended, retake })

/**
 * The player confirmed a layout. `isNew`: it's the photo they just took (analyzed but not
 * saved yet), saved now as the next photo. Otherwise it fixes the latest photo, or confirms
 * a retake of it: that photo is replayed with these balls, recomputing the shot it showed
 * (what went in, whose turn).
 */
export async function correctLayout(id: string, balls: LayoutBall[], intended: IntendedShot | null = null, isNew = false) {
  const r = record(id)
  const { state, view } = await call<{ state: unknown; view: GameAnalyzeResponse }>('layout', {
    record: sent(r), balls, intended, new: isNew,
  })
  saveRecord({ ...r, state, game: view.game })
  return view
}

/** The player says whose turn it is, when the photos got it wrong. Holds until the next photo. */
export async function setTurn(id: string, turn: 0 | 1) {
  const r = record(id)
  const { state, game } = await call<{ state: unknown; game: Game }>('turn', { record: sent(r), turn })
  saveRecord({ ...r, state, game })
  return game
}

/**
 * The player fixed the gutter: exactly these balls are pocketed. `balls`: the latest
 * photo's layout with that change made (a ball put in the gutter taken off the table, one
 * taken out placed back on); null when the table didn't change.
 */
export async function correctPocketed(id: string, pocketed: GutterEntry[], balls: LayoutBall[] | null) {
  const r = record(id)
  const { state, view } = await call<{ state: unknown; view: GameAnalyzeResponse }>('pocketed', {
    record: sent(r), pocketed, balls,
  })
  saveRecord({ ...r, state, game: view.game })
  return view
}

export interface PlanResponse {
  physics: ShotPhysics | null // null: no power and spin tried pockets this shot
  speed: 'soft' | 'medium' | 'firm' | 'hard' | null
  spin_name: string | null
}

/** Physics only: the best power and spin for one shot from this layout. Needs no game. */
export const planShot = (
  balls: { id: number | null; type: string; x: number; y: number }[],
  group: 'solid' | 'stripe' | null,
  shot: { target_id: number; pocket: string; kind: 'direct' | 'bank'; cut_angle?: number },
) => call<PlanResponse>('plan', { balls, group, ...shot })

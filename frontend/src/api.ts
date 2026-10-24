import type { AnalyzeResponse, Advice, Candidate, Game, GameAnalyzeResponse, IntendedShot, PlayerStats } from './types'

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    // FastAPI validation errors put a list in `detail`; ours put a string.
    const detail = Array.isArray(body?.detail) ? body.detail[0]?.msg : body?.detail
    throw new Error(detail ?? `Server returned ${res.status}`)
  }
  return res.json()
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function photoForm(photo: Blob): RequestInit {
  const form = new FormData()
  form.append('photo', photo, 'table.jpg') // field name must match FastAPI's `photo` param
  return { method: 'POST', body: form }
}

export const analyzePhoto = (photo: Blob) => request<AnalyzeResponse>('/analyze', photoForm(photo))

export const createGame = (players: [string, string]) => request<Game>('/games', json({ players }))

export const getGame = (id: string) => request<Game>(`/games/${id}`)

export const analyzeGamePhoto = (id: string, photo: Blob) =>
  request<GameAnalyzeResponse>(`/games/${id}/analyze`, photoForm(photo))

export const recordShot = (id: string, pocketed: number[], scratch: boolean, intended: IntendedShot | null) =>
  request<Game>(`/games/${id}/shot`, json({ pocketed, scratch, intended }))

export const getAdvice = (id: string, candidates: Candidate[]) =>
  request<Advice>(`/games/${id}/advice`, json({ candidates }))

/** MP3 of the latest advice read aloud. `nonce` busts the cache after new advice. */
export const adviceAudioUrl = (id: string, nonce: number) => `${API_URL}/games/${id}/advice/audio?n=${nonce}`

export const getStats = (name: string) => request<PlayerStats>(`/players/${encodeURIComponent(name)}/stats`)

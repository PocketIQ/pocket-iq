import type {
  AnalyzeResponse,
  Advice,
  Candidate,
  Game,
  GameAnalyzeResponse,
  IntendedShot,
  LayoutBall,
  PlayerStats,
} from './types'

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

function photoForm(photo: Blob, fields: Record<string, string> = {}): RequestInit {
  const form = new FormData()
  form.append('photo', photo, 'table.jpg') // field name must match FastAPI's `photo` param
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return { method: 'POST', body: form }
}

export const analyzePhoto = (photo: Blob) => request<AnalyzeResponse>('/analyze', photoForm(photo))

export const createGame = (players: [string, string]) => request<Game>('/games', json({ players }))

export const getGame = (id: string) => request<Game>(`/games/${id}`)

/**
 * The next photo of the table. The backend compares it with the previous one to work out
 * the shot in between (what went in, scratch) and applies it. `intended`: the shot the
 * player went for. `retake`: replace the latest photo instead of following it.
 */
export function analyzeGamePhoto(
  id: string,
  photo: Blob,
  { intended = null, retake = false }: { intended?: IntendedShot | null; retake?: boolean } = {},
) {
  const fields: Record<string, string> = { retake: String(retake) }
  if (intended) fields.intended = JSON.stringify(intended)
  return request<GameAnalyzeResponse>(`/games/${id}/analyze`, photoForm(photo, fields))
}

/**
 * The player fixed the latest photo's layout. The backend replays that photo with these
 * balls, recomputing the shot it showed (what went in, whose turn). For the editor.
 */
export const correctLayout = (id: string, balls: LayoutBall[], intended: IntendedShot | null = null) => {
  const init = json({ balls, intended })
  return request<GameAnalyzeResponse>(`/games/${id}/layout`, { ...init, method: 'PUT' })
}

export const getAdvice = (id: string, candidates: Candidate[]) =>
  request<Advice>(`/games/${id}/advice`, json({ candidates }))

/** MP3 of the latest advice read aloud. `nonce` busts the cache after new advice. */
export const adviceAudioUrl = (id: string, nonce: number) => `${API_URL}/games/${id}/advice/audio?n=${nonce}`

export const getStats = (name: string) => request<PlayerStats>(`/players/${encodeURIComponent(name)}/stats`)

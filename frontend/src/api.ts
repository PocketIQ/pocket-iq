import type { AnalyzeResponse } from './types'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export async function analyzePhoto(photo: Blob): Promise<AnalyzeResponse> {
  const form = new FormData()
  form.append('photo', photo, 'table.jpg') // field name must match FastAPI's `photo` param

  const res = await fetch(`${API_URL}/analyze`, { method: 'POST', body: form })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail ?? `Server returned ${res.status}`)
  }
  return res.json()
}

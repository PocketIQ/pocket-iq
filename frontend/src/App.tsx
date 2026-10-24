import { useState } from 'react'
import { analyzePhoto } from './api'
import { resizeImage } from './resizeImage'
import { TableCanvas } from './TableCanvas'
import type { AnalyzeResponse } from './types'

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string }

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [result, setResult] = useState<AnalyzeResponse | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same photo again still fires onChange
    if (!file) return

    setStatus({ kind: 'loading' })
    try {
      const small = await resizeImage(file)
      setResult(await analyzePhoto(small))
      setStatus({ kind: 'idle' })
    } catch (err) {
      setStatus({
        kind: 'error',
        message:
          err instanceof TypeError
            ? 'Couldn’t reach the server. Check that FastAPI is running and VITE_API_URL is right.'
            : (err as Error).message,
      })
    }
  }

  return (
    <main className="min-h-dvh bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto max-w-2xl px-4 py-6 flex flex-col gap-5">
        <header>
          <h1 className="text-2xl font-bold">CueIQ</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            Snap the table with all four corner markers in frame.
          </p>
        </header>

        {/* capture="environment" opens the rear camera on phones; on laptops it's a file picker */}
        <label className="flex items-center justify-center rounded-xl bg-emerald-700 px-5 py-4 text-lg font-semibold text-white active:bg-emerald-800 cursor-pointer focus-within:ring-4 focus-within:ring-emerald-400">
          {status.kind === 'loading' ? 'Reading the table…' : result ? 'Take next photo' : 'Take photo'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={handleFile}
            disabled={status.kind === 'loading'}
          />
        </label>

        {status.kind === 'error' && (
          <p role="alert" className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {status.message}
          </p>
        )}

        {result && (
          <section className="flex flex-col gap-2">
            <TableCanvas data={result} />
            <p className="text-xs text-stone-500">
              {result.balls.length} balls · dashed ring = low confidence
              {result.debug &&
                ` · server got ${(result.debug.received_bytes / 1024).toFixed(0)} KB, ${result.debug.image_size.join('×')}`}
            </p>
          </section>
        )}
      </div>
    </main>
  )
}

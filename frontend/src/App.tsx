import { useEffect, useMemo, useState } from 'react'
import { analyzePhoto } from './api'
import { findShots } from './physics/shots'
import { resizeImage } from './resizeImage'
import { TableCanvas } from './TableCanvas'
import type { Group } from './physics/shots'
import type { AnalyzeResponse } from './types'

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string }

const GROUPS: { value: Group; label: string }[] = [
  { value: 'solid', label: 'Solids' },
  { value: 'stripe', label: 'Stripes' },
  { value: null, label: 'Table open' },
]

function difficultyLabel(difficulty: number): string {
  if (difficulty < 0.35) return 'Easy'
  if (difficulty < 0.6) return 'Medium'
  return 'Hard'
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [result, setResult] = useState<AnalyzeResponse | null>(null)
  const [group, setGroup] = useState<Group>(null)
  const [selected, setSelected] = useState(0)

  const shots = useMemo(() => result ? findShots(result.balls, result.table, result.ball_radius, group) : [], [result, group])

  useEffect(() => {
    setSelected(0)
  }, [shots])

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
            Tape a marker at each corner (and the side pockets if you have them), then snap
            the table with at least four markers in frame.
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
            <div role="group" aria-label="Group" className="grid grid-cols-3 gap-1 rounded-xl bg-stone-200 p-1 dark:bg-stone-800">
              {GROUPS.map((option) => {
                const active = group === option.value
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setGroup(option.value)}
                    className={`rounded-lg px-2 py-2 text-sm font-semibold ${
                      active
                        ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-950 dark:text-stone-100'
                        : 'text-stone-600 dark:text-stone-400'
                    }`}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>

            <TableCanvas data={result} shots={shots.slice(0, 3)} selected={selected} />
            <p className="text-xs text-stone-500">
              {result.balls.length} balls · dashed ring = low confidence
              {result.debug?.markers_used &&
                ` · markers ${result.debug.markers_used.join(', ')}`}
              {result.debug &&
                ` · ${result.debug.image_size.join('×')}`}
            </p>

            {shots.length === 0 ? (
              <p className="rounded-xl bg-white px-4 py-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                No clear shot found
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {shots.slice(0, 3).map((shot, i) => {
                  const active = i === selected
                  return (
                    <li key={`${shot.targetIndex}-${shot.pocket}-${shot.kind}-${i}`}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelected(i)}
                        className={`w-full rounded-xl px-4 py-3 text-left ${
                          active
                            ? 'bg-emerald-700 text-white'
                            : 'bg-white text-stone-900 dark:bg-stone-900 dark:text-stone-100'
                        }`}
                      >
                        <span className="block font-semibold">
                          Ball {shot.targetId ?? '?'} {'->'} {shot.pocket.replaceAll('_', ' ')}
                        </span>
                        <span className={`mt-0.5 block text-sm ${active ? 'text-emerald-100' : 'text-stone-600 dark:text-stone-400'}`}>
                          {shot.kind} · {shot.cutAngle}° · {difficultyLabel(shot.difficulty)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  )
}

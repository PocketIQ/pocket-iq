import { useEffect, useMemo, useState } from 'react'
import { analyzePhoto } from './api'
import { BallPicker } from './BallPicker'
import { EditToolbar } from './EditToolbar'
import { MOCK_TABLE } from './mockTable'
import { findShots } from './physics/shots'
import { resizeImage } from './resizeImage'
import { RAIL, TableCanvas } from './TableCanvas'
import type { Tool } from './EditToolbar'
import type { Group } from './physics/shots'
import type { AnalyzeResponse, Ball } from './types'

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string }

type History = { past: Ball[][]; future: Ball[][] }

const EMPTY_HISTORY: History = { past: [], future: [] }

/** Labels a ball as the cue (0) or a numbered ball. Same array back if nothing changes. */
function setBall(balls: Ball[], index: number, n: number): Ball[] {
  const target = balls[index]
  if (!target) return balls
  const type = n === 0 ? 'cue' : n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe'
  const id = n === 0 ? null : n
  if (target.type === type && target.id === id) return balls
  // Each ball exists once: whichever ball had this label loses it.
  return balls.map((ball, i) => {
    if (i === index) return { ...ball, type, id, confidence: 1 }
    if (type === 'cue' && ball.type === 'cue') return { ...ball, type: 'solid' as const, id: null, confidence: 1 }
    if (id != null && ball.id === id) return { ...ball, type: id === 8 ? 'solid' as const : ball.type, id: null, confidence: 1 }
    return ball
  })
}

const TOOL_HINTS: Record<Tool, string> = {
  label: 'Tap a ball to say which one it is.',
  remove: 'Tap a ball that isn’t really there.',
}

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
  const [confirmed, setConfirmed] = useState(false)
  const [tool, setTool] = useState<Tool>('label')
  const [picking, setPicking] = useState<number | null>(null)
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)

  const needsCheck = result ? result.balls.filter((ball) => ball.confidence < 0.7).length : 0

  const shots = useMemo(
    () => (result && confirmed ? findShots(result.balls, result.table, result.ball_radius, group) : []),
    [result, group, confirmed],
  )

  useEffect(() => {
    setSelected(0)
  }, [shots])

  function loadResult(next: AnalyzeResponse) {
    setResult(next)
    setConfirmed(false)
    setHistory(EMPTY_HISTORY)
    setPicking(null)
    setStatus({ kind: 'idle' })
  }

  function onBallTap(index: number) {
    if (!result) return
    if (tool === 'label') setPicking(index)
    else commit(result.balls.filter((_, i) => i !== index))
  }

  function onPick(n: number) {
    if (!result || picking == null) return
    commit(setBall(result.balls, picking, n))
    setPicking(null)
  }

  function commit(balls: Ball[]) {
    if (!result || balls === result.balls) return
    setHistory({ past: [...history.past, result.balls], future: [] })
    setResult({ ...result, balls })
    setConfirmed(false)
  }

  function undo() {
    const prev = history.past.at(-1)
    if (!result || !prev) return
    setHistory({ past: history.past.slice(0, -1), future: [result.balls, ...history.future] })
    setResult({ ...result, balls: prev })
    setConfirmed(false)
  }

  function redo() {
    const [next, ...rest] = history.future
    if (!result || !next) return
    setHistory({ past: [...history.past, result.balls], future: rest })
    setResult({ ...result, balls: next })
    setConfirmed(false)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same photo again still fires onChange
    if (!file) return

    setStatus({ kind: 'loading' })
    try {
      const small = await resizeImage(file)
      loadResult(await analyzePhoto(small))
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

        {/* Dev only: skip the camera + backend and load a canned table */}
        {import.meta.env.DEV && (
          <button
            type="button"
            onClick={() => loadResult(structuredClone(MOCK_TABLE))}
            className="rounded-xl border border-dashed border-stone-400 px-5 py-2 text-sm font-semibold text-stone-600 dark:text-stone-400"
          >
            Load test table
          </button>
        )}

        {status.kind === 'error' && (
          <p role="alert" className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {status.message}
          </p>
        )}

        {result && (
          <section className="flex flex-col gap-2">
            {confirmed && (
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
            )}

            {!confirmed && needsCheck > 0 && (
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                {needsCheck} {needsCheck === 1 ? 'ball needs' : 'balls need'} a check
              </p>
            )}

            {!confirmed && (
              <EditToolbar
                tool={tool}
                onToolChange={setTool}
                canUndo={history.past.length > 0}
                canRedo={history.future.length > 0}
                onUndo={undo}
                onRedo={redo}
              />
            )}

            {/* .table-stage goes full screen in phone landscape (see index.css) */}
            <div
              className="table-stage"
              style={{ '--table-aspect': (result.table.width + RAIL * 2) / (result.table.height + RAIL * 2) } as React.CSSProperties}
            >
              <TableCanvas
                data={result}
                shots={shots.slice(0, 3)}
                selected={selected}
                showConfidence={!confirmed}
                highlight={picking}
                onBallTap={confirmed ? undefined : onBallTap}
              />
              {!confirmed && (
                <div className="stage-tools">
                  <EditToolbar
                    vertical
                    tool={tool}
                    onToolChange={setTool}
                    canUndo={history.past.length > 0}
                    canRedo={history.future.length > 0}
                    onUndo={undo}
                    onRedo={redo}
                    onConfirm={() => setConfirmed(true)}
                  />
                </div>
              )}
            </div>

            {!confirmed ? (
              <>
                <p className="text-sm text-stone-600 dark:text-stone-400">{TOOL_HINTS[tool]}</p>
                <p className="text-xs text-stone-500">
                  {result.balls.length} balls · dashed ring = low confidence
                  {result.debug?.markers_used &&
                    ` · markers ${result.debug.markers_used.join(', ')}`}
                  {result.debug &&
                    ` · ${result.debug.image_size.join('×')}`}
                </p>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmed(false)}
                className="self-start py-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300"
              >
                Edit layout
              </button>
            )}

            {!confirmed ? (
              <button
                type="button"
                onClick={() => setConfirmed(true)}
                className="flex items-center justify-center rounded-xl bg-emerald-700 px-5 py-4 text-lg font-semibold text-white active:bg-emerald-800"
              >
                Confirm layout
              </button>
            ) : shots.length === 0 ? (
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

      {result && picking != null && result.balls[picking] && (
        <BallPicker ball={result.balls[picking]} onPick={onPick} onClose={() => setPicking(null)} />
      )}
    </main>
  )
}

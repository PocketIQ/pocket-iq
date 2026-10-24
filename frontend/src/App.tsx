import { useEffect, useMemo, useState } from 'react'
import { adviceAudioUrl, analyzeGamePhoto, createGame, getAdvice, getGame, recordShot } from './api'
import { findShots, type Shot } from './physics/shots'
import { resizeImage } from './resizeImage'
import { TableCanvas } from './TableCanvas'
import type { Advice, Candidate, Game, GameAnalyzeResponse } from './types'

type Status = { kind: 'idle' } | { kind: 'loading'; what: string } | { kind: 'error'; message: string }

const GAME_KEY = 'cueiq.game' // resume the game after a reload
const SHOTS_SHOWN = 5
const SHOTS_TO_COACH = 8

const BALL_COLORS: Record<number, string> = {
  1: '#f5c400', 2: '#1d4fd8', 3: '#d62828', 4: '#6b2fa3',
  5: '#f77f00', 6: '#1f8a4c', 7: '#7a1f1f', 8: '#141414',
}

function errorMessage(err: unknown): string {
  return err instanceof TypeError
    ? 'Couldn’t reach the server. Check that FastAPI is running and VITE_API_URL is right.'
    : (err as Error).message
}

const pathLength = (pts: { x: number; y: number }[]) =>
  pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)

function toCandidates(shots: Shot[]): Candidate[] {
  return shots.slice(0, SHOTS_TO_COACH).flatMap((s, index) =>
    s.targetId == null
      ? []
      : [{
        index,
        target_id: s.targetId,
        pocket: s.pocket,
        kind: s.kind,
        cut_angle: s.cutAngle,
        difficulty: s.difficulty,
        cue_distance: Math.round(pathLength(s.cuePath)),
        target_distance: Math.round(pathLength(s.targetPath)),
      }],
  )
}

const pocketName = (p: string) => p.replace('_', ' ')

function BallChip({ id, on, unseen, onClick }: { id: number; on: boolean; unseen?: boolean; onClick: () => void }) {
  const color = BALL_COLORS[((id - 1) % 8) + 1]
  const stripe = id > 8
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={unseen ? `${id} (not seen in the last photo)` : String(id)}
      className={`relative flex size-10 items-center justify-center rounded-full text-xs font-bold ring-offset-2 ring-offset-stone-100 dark:ring-offset-stone-950 ${on ? 'ring-4 ring-emerald-500' : unseen ? 'ring-2 ring-amber-400 ring-dashed' : ''
        }`}
      style={{
        background: stripe ? `linear-gradient(#f8f6ef 28%, ${color} 28% 72%, #f8f6ef 72%)` : color,
      }}
    >
      <span className="flex size-5 items-center justify-center rounded-full bg-white text-stone-900">{id}</span>
    </button>
  )
}

function Setup({ onStart, busy }: { onStart: (names: [string, string]) => void; busy: boolean }) {
  const [names, setNames] = useState<[string, string]>(['', ''])
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={e => {
        e.preventDefault()
        onStart(names)
      }}
    >
      <p className="text-sm text-stone-600 dark:text-stone-400">
        8-ball, two players. The coach remembers each player across games, so use the same names next time.
      </p>
      {[0, 1].map(i => (
        <label key={i} className="flex flex-col gap-1 text-sm font-medium">
          {i === 0 ? 'Player 1 (breaks)' : 'Player 2'}
          <input
            required
            value={names[i]}
            onChange={e => setNames(n => (i === 0 ? [e.target.value, n[1]] : [n[0], e.target.value]))}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-base dark:border-stone-700 dark:bg-stone-900"
          />
        </label>
      ))}
      <button
        disabled={busy}
        className="rounded-xl bg-emerald-700 px-5 py-3 text-lg font-semibold text-white active:bg-emerald-800 disabled:opacity-60"
      >
        {busy ? 'Starting…' : 'Start game'}
      </button>
    </form>
  )
}

function Scoreboard({ game }: { game: Game }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {game.players.map((p, i) => {
        const left = p.group
          ? Object.entries(game.balls).filter(
            ([b, s]) => s === 'on' && b !== 'cue' && b !== '8' && (Number(b) < 8) === (p.group === 'solid'),
          ).length
          : null
        const up = game.winner == null && game.turn === i
        return (
          <div
            key={p.name}
            className={`rounded-lg px-3 py-2 ${up ? 'bg-emerald-700 text-white' : 'bg-stone-200 dark:bg-stone-800'}`}
          >
            <div className="font-semibold">
              {p.name} {game.winner === i && '🏆'}
            </div>
            <div className="text-xs opacity-80">
              {p.group ? `${p.group}s · ${left} left` : 'open table'}
              {up && ' · your shot'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CoachCard({ advice, shot, audioUrl }: { advice: Advice; shot?: Shot; audioUrl: string }) {
  const [voiceError, setVoiceError] = useState(false)
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-white p-4 text-sm shadow-sm dark:bg-stone-900">
      <h2 className="text-base font-semibold">
        {advice.shot_index < 0 || !shot
          ? 'No good shot: play safe'
          : `The ${advice.target_ball} into the ${pocketName(advice.pocket ?? '')}`}
      </h2>
      <p>
        <span className="font-medium">Aim:</span> {advice.aim}
      </p>
      <p className="flex flex-wrap gap-2">
        <span className="rounded-full bg-stone-200 px-2 py-0.5 dark:bg-stone-800">speed: {advice.speed}</span>
        <span className="rounded-full bg-stone-200 px-2 py-0.5 dark:bg-stone-800">spin: {advice.spin}</span>
        {shot && <span className="rounded-full bg-stone-200 px-2 py-0.5 dark:bg-stone-800">cut {shot.cutAngle}°</span>}
      </p>
      <p>
        <span className="font-medium">Cue ball after:</span> {advice.cue_ball_after}
      </p>
      <p className="text-stone-600 dark:text-stone-400">{advice.why}</p>
      {advice.tip && <p className="rounded-lg bg-amber-100 px-3 py-2 text-amber-950 dark:bg-amber-950 dark:text-amber-100">{advice.tip}</p>}
      {/* Read aloud by ElevenLabs, so the player can keep both hands on the cue */}
      {voiceError ? (
        <p className="text-xs text-stone-500">Voice isn’t available right now.</p>
      ) : (
        <audio controls autoPlay src={audioUrl} onError={() => setVoiceError(true)} className="w-full" />
      )}
      <p className="text-xs text-stone-500">Coached by Gemini, using this player’s shot history</p>
    </section>
  )
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [game, setGame] = useState<Game | null>(null)
  const [view, setView] = useState<GameAnalyzeResponse | null>(null)
  const [selected, setSelected] = useState(0)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [adviceCount, setAdviceCount] = useState(0) // new audio URL per piece of advice
  const [pocketed, setPocketed] = useState<Set<number>>(new Set())
  const [scratch, setScratch] = useState(false)

  const busy = status.kind === 'loading'

  // Resume the last game after a reload.
  useEffect(() => {
    let id: string | null = null
    try {
      id = localStorage.getItem(GAME_KEY)
    } catch {
      /* storage blocked: just start fresh */
    }
    if (id) getGame(id).then(setGame).catch(() => localStorage.removeItem(GAME_KEY))
  }, [])

  const player = game ? game.players[game.turn] : null
  const shots = useMemo(
    () => (view && player ? findShots(view.balls, view.table, view.ball_radius, player.group) : []),
    [view, player],
  )

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    setStatus({ kind: 'loading', what })
    try {
      const out = await fn()
      setStatus({ kind: 'idle' })
      return out
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) })
    }
  }

  async function start(names: [string, string]) {
    const g = await run('Starting…', () => createGame(names))
    if (!g) return
    try {
      localStorage.setItem(GAME_KEY, g.id)
    } catch {
      /* resuming after reload just won't work */
    }
    setGame(g)
    setView(null)
    setAdvice(null)
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same photo again still fires onChange
    if (!file || !game) return
    const res = await run('Reading the table…', async () => analyzeGamePhoto(game.id, await resizeImage(file)))
    if (!res) return
    setView(res)
    setGame(res.game)
    setSelected(0)
    setAdvice(null)
    setPocketed(new Set())
    setScratch(false)
  }

  async function askCoach() {
    if (!game) return
    const a = await run('Asking the coach…', () => getAdvice(game.id, toCandidates(shots)))
    if (!a) return
    setAdvice(a)
    setAdviceCount(n => n + 1)
    if (a.shot_index >= 0) setSelected(a.shot_index)
  }

  async function submitShot() {
    if (!game) return
    // The shot selected on screen is the one they went for: it's what counts as made or
    // missed in their stats.
    const shot = shots[selected]
    const intended =
      view && shot?.targetId != null
        ? { target: shot.targetId, pocket: shot.pocket, kind: shot.kind, cut_angle: shot.cutAngle }
        : null
    const g = await run('Saving the shot…', () => recordShot(game.id, [...pocketed], scratch, intended))
    if (!g) return
    setGame(g)
    setView(null) // balls moved: the old picture and shots no longer apply
    setAdvice(null)
    setPocketed(new Set())
    setScratch(false)
  }

  function newGame() {
    try {
      localStorage.removeItem(GAME_KEY)
    } catch {
      /* nothing to forget */
    }
    setGame(null)
    setView(null)
    setAdvice(null)
  }

  const inPlay = game
    ? Object.entries(game.balls)
      .filter(([b, s]) => s === 'on' && b !== 'cue')
      .map(([b]) => Number(b))
      .sort((a, b) => a - b)
    : []
  const missing = new Set(view?.missing ?? [])
  const last = game?.history.at(-1)

  return (
    <main className="min-h-dvh bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto max-w-2xl px-4 py-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">PocketIQ</h1>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Snap the whole table from the side. All four rails in the shot.
            </p>
          </div>
          {game && (
            <button onClick={newGame} className="text-sm text-stone-500 underline">
              New game
            </button>
          )}
        </header>

        {status.kind === 'error' && (
          <p role="alert" className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {status.message}
          </p>
        )}

        {!game && <Setup onStart={start} busy={busy} />}

        {game && (
          <>
            <Scoreboard game={game} />

            {game.winner != null ? (
              <p className="rounded-xl bg-emerald-100 px-4 py-3 text-center text-lg font-semibold text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100">
                {game.players[game.winner].name} wins!
              </p>
            ) : (
              <>
                {last && !view && (
                  <p className="text-sm text-stone-600 dark:text-stone-400">
                    Last shot: {last.player} pocketed {last.pocketed.join(', ') || 'nothing'}
                    {last.scratch && ' and scratched'} · {last.result}. {player?.name}, take a photo for your shot.
                  </p>
                )}

                {/* capture="environment" opens the rear camera on phones; on laptops it's a file picker */}
                <label className="flex items-center justify-center rounded-xl bg-emerald-700 px-5 py-4 text-lg font-semibold text-white active:bg-emerald-800 cursor-pointer focus-within:ring-4 focus-within:ring-emerald-400">
                  {busy ? status.what : view ? 'Retake photo' : `Photo for ${player?.name}’s shot`}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={handlePhoto}
                    disabled={busy}
                  />
                </label>
              </>
            )}

            {view && game.winner == null && (
              <>
                {view.missing.length > 0 && (
                  <p className="rounded-lg bg-amber-100 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
                    Didn’t see {view.missing.map(b => (b === 'cue' ? 'the cue ball' : b)).join(', ')}. Hidden, or
                    pocketed? Balls stay in play until you mark them pocketed below.
                  </p>
                )}

                <section className="flex flex-col gap-2">
                  <TableCanvas data={view} shots={shots.slice(0, SHOTS_SHOWN)} selected={selected} />
                  <p className="text-xs text-stone-500">
                    {view.balls.length} balls · dashed ring = unsure
                    {view.rejected.length > 0 && ` · ignored ${view.rejected.length} false detection(s)`}
                  </p>
                </section>

                {shots.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                      {shots.slice(0, SHOTS_SHOWN).map((s, i) => (
                        <button
                          key={i}
                          onClick={() => setSelected(i)}
                          aria-pressed={selected === i}
                          className={`rounded-lg px-3 py-1.5 text-sm ${selected === i ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900' : 'bg-stone-200 dark:bg-stone-800'
                            }`}
                        >
                          {s.targetId ?? '?'} → {pocketName(s.pocket)} · {s.cutAngle}°{s.kind === 'bank' && ' bank'}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-stone-600 dark:text-stone-400">No clear shot at a legal ball. Ask the coach for a safety.</p>
                )}

                <button
                  onClick={askCoach}
                  disabled={busy}
                  className="rounded-xl bg-stone-900 px-5 py-3 font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-stone-900"
                >
                  {status.kind === 'loading' && status.what.startsWith('Asking') ? status.what : 'Ask the coach'}
                </button>
                {advice && (
                  <CoachCard
                    key={adviceCount}
                    advice={advice}
                    shot={advice.shot_index >= 0 ? shots[advice.shot_index] : undefined}
                    audioUrl={adviceAudioUrl(game.id, adviceCount)}
                  />
                )}
              </>
            )}

            {game.winner == null && (
              <section className="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm dark:bg-stone-900">
                <h2 className="font-semibold">After {player?.name}’s shot: what went in?</h2>
                <div className="flex flex-wrap gap-2">
                  {inPlay.map(id => (
                    <BallChip
                      key={id}
                      id={id}
                      on={pocketed.has(id)}
                      unseen={missing.has(String(id))}
                      onClick={() =>
                        setPocketed(s => {
                          const next = new Set(s)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                    />
                  ))}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={scratch} onChange={e => setScratch(e.target.checked)} className="size-4" />
                  Scratched (cue ball went in){missing.has('cue') && ' · the cue ball wasn’t seen'}
                </label>
                <button
                  onClick={submitShot}
                  disabled={busy}
                  className="rounded-xl bg-emerald-700 px-5 py-3 font-semibold text-white active:bg-emerald-800 disabled:opacity-60"
                >
                  {pocketed.size || scratch ? 'Record shot' : 'Nothing went in: next turn'}
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}

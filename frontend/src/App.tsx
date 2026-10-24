import { useEffect, useMemo, useState } from 'react'
import { adviceAudioUrl, analyzeGamePhoto, createGame, getAdvice, getGame } from './api'
import { findShots, type Shot } from './physics/shots'
import { resizeImage } from './resizeImage'
import { TableCanvas } from './TableCanvas'
import type { Advice, Candidate, Game, GameAnalyzeResponse, IntendedShot, ShotEvent } from './types'

type Status = { kind: 'idle' } | { kind: 'loading'; what: string } | { kind: 'error'; message: string }

const GAME_KEY = 'cueiq.game' // resume the game after a reload
const SHOTS_SHOWN = 5
const SHOTS_TO_COACH = 8

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

// After a reload, rebuild the table view from the game's latest photo.
function viewFromLayout(game: Game): GameAnalyzeResponse | null {
  if (!game.layout) return null
  return {
    table: { width: 1000, height: 500 },
    ball_radius: 11,
    balls: game.layout.balls,
    missing: [],
    rejected: [],
    shot: null,
    game,
  }
}

function describeShot(shot: ShotEvent): string {
  const what = shot.pocketed.length ? `pocketed ${shot.pocketed.join(', ')}` : 'pocketed nothing'
  return `${shot.player} ${what}${shot.scratch ? ' and scratched' : ''} · ${shot.result}`
}

function PhotoButton({ label, onFile, disabled, primary }: {
  label: string
  onFile: (file: File) => void
  disabled: boolean
  primary?: boolean
}) {
  return (
    // capture="environment" opens the rear camera on phones; on laptops it's a file picker
    <label
      className={`flex cursor-pointer items-center justify-center rounded-xl px-5 font-semibold focus-within:ring-4 focus-within:ring-emerald-400 ${
        primary
          ? 'bg-emerald-700 py-4 text-lg text-white active:bg-emerald-800'
          : 'bg-stone-200 py-2.5 text-sm dark:bg-stone-800'
      }`}
    >
      {label}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = '' // so picking the same photo again still fires onChange
          if (file) onFile(file)
        }}
      />
    </label>
  )
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [game, setGame] = useState<Game | null>(null)
  const [view, setView] = useState<GameAnalyzeResponse | null>(null)
  const [selected, setSelected] = useState(0)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [adviceCount, setAdviceCount] = useState(0) // new audio URL per piece of advice

  const busy = status.kind === 'loading'

  // Resume the last game after a reload.
  useEffect(() => {
    let id: string | null = null
    try {
      id = localStorage.getItem(GAME_KEY)
    } catch {
      /* storage blocked: just start fresh */
    }
    if (id)
      getGame(id)
        .then(g => {
          setGame(g)
          setView(viewFromLayout(g))
        })
        .catch(() => localStorage.removeItem(GAME_KEY))
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

  // Every photo after the first shows the result of the shot before it: the backend
  // works out what went in by comparing it with the previous photo.
  async function handlePhoto(file: File, retake: boolean) {
    if (!game) return
    // The shot selected on screen is the one they went for: it's what counts as made or
    // missed in their stats. A retake keeps what was sent with the original photo.
    const shot = shots[selected]
    const intended: IntendedShot | null =
      !retake && shot?.targetId != null
        ? { target: shot.targetId, pocket: shot.pocket, kind: shot.kind, cut_angle: shot.cutAngle }
        : null
    const res = await run('Reading the table…', async () =>
      analyzeGamePhoto(game.id, await resizeImage(file), { intended, retake }),
    )
    if (!res) return
    setView(res)
    setGame(res.game)
    setSelected(0)
    setAdvice(null)
  }

  async function askCoach() {
    if (!game) return
    const a = await run('Asking the coach…', () => getAdvice(game.id, toCandidates(shots)))
    if (!a) return
    setAdvice(a)
    setAdviceCount(n => n + 1)
    if (a.shot_index >= 0) setSelected(a.shot_index)
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

  const photoCount = game?.layout?.n ?? 0

  return (
    <main className="min-h-dvh bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto max-w-2xl px-4 py-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">PocketIQ</h1>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              After every shot, once the balls stop, snap the whole table before anyone touches it.
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

            {view?.shot ? (
              <p className="rounded-lg bg-white px-4 py-3 text-sm shadow-sm dark:bg-stone-900">
                <span className="font-semibold">Last shot:</span> {describeShot(view.shot)}.{' '}
                <span className="text-stone-500">Wrong? Fix the layout or retake the photo.</span>
              </p>
            ) : (
              view &&
              photoCount > 1 && (
                <p className="rounded-lg bg-white px-4 py-3 text-sm text-stone-600 shadow-sm dark:bg-stone-900 dark:text-stone-400">
                  Nothing moved since the last photo, so no shot was recorded.
                </p>
              )
            )}

            {game.winner != null ? (
              <p className="rounded-xl bg-emerald-100 px-4 py-3 text-center text-lg font-semibold text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100">
                {game.players[game.winner].name} wins!
              </p>
            ) : (
              <PhotoButton
                primary
                disabled={busy}
                onFile={f => handlePhoto(f, false)}
                label={
                  busy ? status.what : photoCount === 0 ? 'Photo of the table' : `Photo after ${player?.name}’s shot`
                }
              />
            )}
            {photoCount > 0 && (
              <PhotoButton disabled={busy} onFile={f => handlePhoto(f, true)} label="Retake the last photo" />
            )}

            {view && game.winner == null && (
              <>
                <section className="flex flex-col gap-2">
                  <TableCanvas data={view} shots={shots.slice(0, SHOTS_SHOWN)} selected={selected} />
                  <p className="text-xs text-stone-500">
                    {view.balls.length} balls · dashed ring = unsure
                    {view.missing.length > 0 &&
                      ` · not seen: ${view.missing.map(b => (b === 'cue' ? 'cue ball' : b)).join(', ')} (still in play)`}
                    {view.rejected.length > 0 && ` · ignored ${view.rejected.length} false detection(s)`}
                  </p>
                </section>

                {shots.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {shots.slice(0, SHOTS_SHOWN).map((s, i) => (
                      <button
                        key={i}
                        onClick={() => setSelected(i)}
                        aria-pressed={selected === i}
                        className={`rounded-lg px-3 py-1.5 text-sm ${
                          selected === i ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900' : 'bg-stone-200 dark:bg-stone-800'
                        }`}
                      >
                        {s.targetId ?? '?'} → {pocketName(s.pocket)} · {s.cutAngle}°{s.kind === 'bank' && ' bank'}
                      </button>
                    ))}
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
          </>
        )}
      </div>
    </main>
  )
}

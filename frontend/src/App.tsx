import { useEffect, useMemo, useRef, useState } from 'react'
import { adviceAudioUrl, analyzeGamePhoto, correctLayout, createGame, getAdvice, getGame, planShot } from './api'
import type { PlanResponse } from './api'
import { BallPicker } from './BallPicker'
import { EditToolbar } from './EditToolbar'
import { MOCK_TABLE } from './mockTable'
import { findShots, type Shot } from './physics/shots'
import { resizeImage } from './resizeImage'
import { ShotGuide } from './ShotGuide'
import { guideFromPlan, placeholderGuide } from './spinPower'
import { RAIL, TableCanvas } from './TableCanvas'
import type { Tool } from './EditToolbar'
import type { Advice, Ball, Candidate, Game, GameAnalyzeResponse, IntendedShot, LayoutBall, ShotEvent } from './types'

type Status = { kind: 'idle' } | { kind: 'loading'; what: string } | { kind: 'error'; message: string }

type Coach =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; advice: Advice }
  | { kind: 'error' }
  | { kind: 'off' } // test table

type History = { past: Ball[][]; future: Ball[][] }

const EMPTY_HISTORY: History = { past: [], future: [] }

const GAME_KEY = 'cueiq.game' // resume the game after a reload
const SHOTS_SHOWN = 3
const SHOTS_TO_COACH = 8

// Dev only: a local game for the test table, so the editor works without the backend.
const DEV_GAME: Game = {
  id: 'dev',
  players: [{ name: 'You', group: null }, { name: 'Friend', group: null }],
  turn: 0,
  winner: null,
  balls: Object.fromEntries(['cue', ...Array.from({ length: 15 }, (_, i) => String(i + 1))].map(b => [b, 'on'])),
  history: [],
  layout: null,
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

/** What PUT /games/{id}/layout expects: identities only, the server derives types. */
const toLayout = (balls: Ball[]): LayoutBall[] =>
  balls.map(b => (b.type === 'cue' ? { id: null, type: 'cue', x: b.x, y: b.y } : { id: b.id, x: b.x, y: b.y }))

/** Labels a ball as the cue (0) or a numbered ball. Same array back if nothing changes. */
function setBall(balls: Ball[], index: number, n: number): Ball[] {
  const target = balls[index]
  if (!target) return balls
  const type = n === 0 ? 'cue' : n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe'
  const id = n === 0 ? null : n
  if (target.type === type && target.id === id) {
    // Picking the same label confirms it: the ball stops being flagged as unsure.
    if (target.confidence >= 1) return balls
    return balls.map((ball, i) => (i === index ? { ...ball, confidence: 1 } : ball))
  }
  // Each ball exists once: whichever ball had this label swaps to the tapped ball's old one.
  return balls.map((ball, i) => {
    if (i === index) return { ...ball, type, id, confidence: 1 }
    const holds = n === 0 ? ball.type === 'cue' : ball.id === n
    if (holds) return { ...ball, type: target.type, id: target.id, confidence: 1 }
    return ball
  })
}

const TOOL_HINTS: Record<Tool, string> = {
  label: 'Tap a ball to say which one it is.',
  remove: 'Tap a ball that isn’t really there.',
}

const pocketName = (p: string) => p.replaceAll('_', ' ')

function difficultyLabel(difficulty: number): string {
  if (difficulty < 0.35) return 'Easy'
  if (difficulty < 0.6) return 'Medium'
  return 'Hard'
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

function CoachThinking() {
  return (
    <section role="status" className="flex flex-col gap-3 rounded-xl bg-white p-4 text-sm shadow-sm dark:bg-stone-900">
      <p className="flex items-center gap-2 font-semibold">
        <span className="size-4 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" aria-hidden="true" />
        Coach is thinking…
      </p>
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        <div className="h-3 w-3/4 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-1/2 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-2/3 rounded bg-stone-200 dark:bg-stone-800" />
      </div>
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
  const [serverBalls, setServerBalls] = useState<Ball[] | null>(null) // the layout the backend has
  const [selected, setSelected] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [tool, setTool] = useState<Tool>('label')
  const [picking, setPicking] = useState<number | null>(null)
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)
  const [coach, setCoach] = useState<Coach>({ kind: 'idle' })
  const [adviceCount, setAdviceCount] = useState(0) // new audio URL per piece of advice
  const coachRequest = useRef(0) // bumped to drop advice for a layout that's since changed
  // Physics plan (spin and power) and the shot it's for: a stale one is simply not shown.
  const [plan, setPlan] = useState<{ shot: Shot; result: PlanResponse | null } | null>(null)

  const busy = status.kind === 'loading'
  const devMode = game?.id === DEV_GAME.id

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
          loadView(viewFromLayout(g))
        })
        .catch(() => localStorage.removeItem(GAME_KEY))
  }, [])

  const player = game ? game.players[game.turn] : null
  const shots = useMemo(
    () => (view && player && confirmed ? findShots(view.balls, view.table, view.ball_radius, player.group) : []),
    [view, player, confirmed],
  )

  // Spin and power come from the physics engine (not Gemini), for whichever shot is selected.
  const selectedShot = shots[selected]
  const shooterGroup = player?.group ?? null
  useEffect(() => {
    if (!view || !selectedShot || selectedShot.targetId == null) return
    let live = true
    planShot(
      view.balls.map(({ id, type, x, y }) => ({ id, type, x, y })),
      shooterGroup,
      { target_id: selectedShot.targetId, pocket: selectedShot.pocket, kind: selectedShot.kind, cut_angle: selectedShot.cutAngle },
    )
      .then(result => live && setPlan({ shot: selectedShot, result }))
      .catch(() => live && setPlan({ shot: selectedShot, result: null }))
    return () => {
      live = false
    }
  }, [view, selectedShot, shooterGroup])

  // Top shots, plus the coach's pick if it isn't one of them.
  const shown = shots.slice(0, SHOTS_SHOWN).map((_, i) => i)
  if (selected >= SHOTS_SHOWN && shots[selected]) shown.push(selected)

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

  function resetCoach() {
    coachRequest.current++
    setCoach({ kind: 'idle' })
  }

  // A fresh layout from the backend: back to editing it.
  function loadView(next: GameAnalyzeResponse | null) {
    setView(next)
    setServerBalls(next?.balls ?? null)
    setConfirmed(false)
    setHistory(EMPTY_HISTORY)
    setPicking(null)
    setSelected(0)
    resetCoach()
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
    loadView(null)
  }

  function loadTestTable() {
    setGame(DEV_GAME)
    setStatus({ kind: 'idle' })
    loadView({ ...structuredClone(MOCK_TABLE), missing: [], rejected: [], shot: null, game: DEV_GAME })
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
    setGame(res.game)
    loadView(res)
  }

  function onBallTap(index: number) {
    if (!view) return
    if (tool === 'label') setPicking(index)
    else commit(view.balls.filter((_, i) => i !== index))
  }

  function onPick(n: number) {
    if (!view || picking == null) return
    commit(setBall(view.balls, picking, n))
    setPicking(null)
  }

  function showBalls(balls: Ball[]) {
    if (!view) return
    setView({ ...view, balls })
    setConfirmed(false)
    resetCoach()
  }

  function commit(balls: Ball[]) {
    if (!view || balls === view.balls) return
    setHistory({ past: [...history.past, view.balls], future: [] })
    showBalls(balls)
  }

  function undo() {
    const prev = history.past.at(-1)
    if (!view || !prev) return
    setHistory({ past: history.past.slice(0, -1), future: [view.balls, ...history.future] })
    showBalls(prev)
  }

  function redo() {
    const [next, ...rest] = history.future
    if (!view || !next) return
    setHistory({ past: [...history.past, view.balls], future: rest })
    showBalls(next)
  }

  function editLayout() {
    setConfirmed(false)
    resetCoach()
  }

  // Send any fixes to the backend (it replays the photo, so the detected shot, groups and
  // turn can change), then show shots and ask the coach. Shots never wait on the coach.
  async function confirmLayout() {
    if (!view || !game || busy) return
    if (view.balls.some(b => b.type !== 'cue' && b.id == null)) {
      setStatus({ kind: 'error', message: 'Every ball needs a number before confirming. Tap it with Set ball.' })
      return
    }
    let current = view
    let currentGame = game
    if (!devMode && view.balls !== serverBalls) {
      const res = await run('Saving your fixes…', () => correctLayout(game.id, toLayout(view.balls)))
      if (!res) return
      current = res
      currentGame = res.game
      setGame(res.game)
      setView(res)
      setServerBalls(res.balls)
    }
    setStatus({ kind: 'idle' })
    setConfirmed(true)
    setSelected(0)
    if (currentGame.winner != null) return

    // The coach needs a saved game and Gemini; the test table has neither.
    if (devMode) {
      setCoach({ kind: 'off' })
      return
    }
    const group = currentGame.players[currentGame.turn].group
    const found = findShots(current.balls, current.table, current.ball_radius, group)
    const request = ++coachRequest.current
    setCoach({ kind: 'loading' })
    try {
      const advice = await getAdvice(currentGame.id, toCandidates(found))
      if (request !== coachRequest.current) return
      setCoach({ kind: 'done', advice })
      setAdviceCount(n => n + 1)
      setSelected(advice.shot_index >= 0 && advice.shot_index < found.length ? advice.shot_index : 0)
    } catch {
      if (request !== coachRequest.current) return
      setCoach({ kind: 'error' })
      setSelected(0)
    }
  }

  function newGame() {
    try {
      localStorage.removeItem(GAME_KEY)
    } catch {
      /* nothing to forget */
    }
    setGame(null)
    loadView(null)
  }

  const guide = !selectedShot
    ? placeholderGuide('No shot')
    : plan?.shot !== selectedShot
      ? placeholderGuide('Planning…')
      : plan.result
        ? guideFromPlan(plan.result)
        : placeholderGuide('Physics unavailable')
  const photoCount = game?.layout?.n ?? 0
  const needsCheck = view ? view.balls.filter(ball => ball.confidence < 0.7).length : 0
  const sunk = new Set(
    Object.entries(game?.balls ?? {}).filter(([b, s]) => s === 'sunk' && b !== 'cue').map(([b]) => Number(b)),
  )

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
            <button onClick={newGame} className="shrink-0 py-1 text-sm text-stone-500 underline">
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

        {/* Dev only: skip the camera + backend and load a canned table */}
        {import.meta.env.DEV && (
          <button
            type="button"
            onClick={loadTestTable}
            className="rounded-xl border border-dashed border-stone-400 px-5 py-2 text-sm font-semibold text-stone-600 dark:text-stone-400"
          >
            Load test table
          </button>
        )}

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
                  busy && status.what === 'Reading the table…'
                    ? status.what
                    : photoCount === 0 ? 'Photo of the table' : `Photo after ${player?.name}’s shot`
                }
              />
            )}
            {photoCount > 0 && (
              <PhotoButton disabled={busy} onFile={f => handlePhoto(f, true)} label="Retake the last photo" />
            )}

            {view && game.winner == null && (
              <section className="flex flex-col gap-2">
                {!confirmed && needsCheck > 0 && (
                  <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                    {needsCheck} {needsCheck === 1 ? 'ball needs' : 'balls need'} a check
                  </p>
                )}

                {/* Spin and power take the toolbar's place once the layout is confirmed */}
                {confirmed && <ShotGuide guide={guide} />}

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
                  style={{ '--table-aspect': (view.table.width + RAIL * 2) / (view.table.height + RAIL * 2) } as React.CSSProperties}
                >
                  <TableCanvas
                    data={view}
                    shots={shown.map(i => shots[i])}
                    selected={shown.indexOf(selected)}
                    showConfidence={!confirmed}
                    highlight={picking}
                    onBallTap={confirmed ? undefined : onBallTap}
                    onShotTap={confirmed ? i => setSelected(shown[i]) : undefined}
                  />
                  {confirmed ? (
                    <div className="stage-tools">
                      <ShotGuide vertical guide={guide} />
                    </div>
                  ) : (
                    <div className="stage-tools">
                      <EditToolbar
                        vertical
                        tool={tool}
                        onToolChange={setTool}
                        canUndo={history.past.length > 0}
                        canRedo={history.future.length > 0}
                        onUndo={undo}
                        onRedo={redo}
                        onConfirm={confirmLayout}
                      />
                    </div>
                  )}
                </div>

                {!confirmed ? (
                  <>
                    <p className="text-sm text-stone-600 dark:text-stone-400">{TOOL_HINTS[tool]}</p>
                    <p className="text-xs text-stone-500">
                      {view.balls.length} balls · dashed ring = unsure
                      {view.missing.length > 0 &&
                        ` · not seen: ${view.missing.map(b => (b === 'cue' ? 'cue ball' : b)).join(', ')} (still in play)`}
                      {view.rejected.length > 0 && ` · ignored ${view.rejected.length} false detection(s)`}
                    </p>
                    <button
                      type="button"
                      onClick={confirmLayout}
                      disabled={busy}
                      className="flex items-center justify-center rounded-xl bg-emerald-700 px-5 py-4 text-lg font-semibold text-white active:bg-emerald-800 disabled:opacity-60"
                    >
                      {busy && status.what === 'Saving your fixes…' ? status.what : 'Confirm layout'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={editLayout}
                      className="self-start py-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300"
                    >
                      Edit layout
                    </button>

                    {coach.kind === 'loading' && <CoachThinking />}
                    {coach.kind === 'error' && (
                      <p className="rounded-xl bg-white px-4 py-3 text-sm text-stone-600 shadow-sm dark:bg-stone-900 dark:text-stone-400">
                        Coach unavailable. Here’s the easiest shot.
                      </p>
                    )}
                    {coach.kind === 'off' && (
                      <p className="rounded-xl bg-white px-4 py-3 text-sm text-stone-600 shadow-sm dark:bg-stone-900 dark:text-stone-400">
                        The coach is off for the test table: it needs a real game. Spin and power still come from physics.
                      </p>
                    )}
                    {coach.kind === 'done' && (
                      <CoachCard
                        key={adviceCount}
                        advice={coach.advice}
                        shot={coach.advice.shot_index >= 0 ? shots[coach.advice.shot_index] : undefined}
                        audioUrl={adviceAudioUrl(game.id, adviceCount)}
                      />
                    )}

                    {shots.length === 0 ? (
                      <p className="rounded-xl bg-white px-4 py-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                        No clear shot at a legal ball.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {shown.map(i => {
                          const shot = shots[i]
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
                                  Ball {shot.targetId ?? '?'} {'->'} {pocketName(shot.pocket)}
                                  {coach.kind === 'done' && coach.advice.shot_index === i && ' · coach’s pick'}
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
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {view && picking != null && view.balls[picking] && (
        <BallPicker
          ball={view.balls[picking]}
          unavailable={sunk}
          onPick={onPick}
          onClose={() => setPicking(null)}
        />
      )}
    </main>
  )
}

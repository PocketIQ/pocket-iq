import { useEffect, useMemo, useRef, useState } from 'react'
import { adviceAudioUrl, analyzeGamePhoto, correctLayout, correctPocketed, createGame, getAdvice, getGame, planShot, setTurn } from './api'
import type { PlanResponse } from './api'
import { BallPicker } from './BallPicker'
import { Banner } from './Banner'
import { EditToolbar } from './EditToolbar'
import { Gutter } from './Gutter'
import { gutterView, withGutter } from './gutterBalls'
import { MOCK_ROSTERS, MOCK_TABLE, mockGame } from './mockTable'
import { findShots, type Shot } from './physics/shots'
import { resizeImage } from './resizeImage'
import { Setup } from './Setup'
import { ShotGuide } from './ShotGuide'
import { guideFromPlan, placeholderGuide } from './spinPower'
import { RAIL, TableCanvas } from './TableCanvas'
import { loadRosters, saveRosters, SIDE_COLORS, teamTurns, type Rosters } from './teams'
import type { Tool } from './EditToolbar'
import type { Advice, Ball, Candidate, Game, GameAnalyzeResponse, GutterEntry, IntendedShot, LayoutBall, ShotEvent } from './types'

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

const DEV_GAME_ID = 'dev' // the test table's local game: no backend
const TEST_TOOLS_KEY = 'cueiq.testTools' // "hidden" = the test table buttons are tucked away

function testToolsHidden(): boolean {
  try {
    return localStorage.getItem(TEST_TOOLS_KEY) === 'hidden'
  } catch {
    return false
  }
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

const ballType = (n: number): Ball['type'] => (n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe')

/** A gutter fix that changes the table: a ball comes off it, or goes back on at a spot. */
type TableChange = { off: number } | { on: Ball }

function changeTable(balls: Ball[], change: TableChange): Ball[] {
  return 'off' in change ? balls.filter(b => b.id !== change.off) : [...balls, change.on]
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

function SwapButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-label="Switch whose turn it is"
      title="Switch whose turn it is"
      onClick={onClick}
      disabled={disabled}
      className="flex size-9 items-center justify-center self-center rounded-full bg-stone-200 text-stone-600 active:bg-stone-300 disabled:opacity-30 dark:bg-stone-800 dark:text-stone-300 dark:active:bg-stone-700"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9h15l-4-4M20 15H5l4 4" />
      </svg>
    </button>
  )
}

function Scoreboard({ game, up, onSwap, swapDisabled }: {
  game: Game
  up: string | null
  onSwap: () => void
  swapDisabled: boolean
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
      {game.players.flatMap((p, i) => {
        const left = p.group
          ? Object.entries(game.balls).filter(
            ([b, s]) => s === 'on' && b !== 'cue' && b !== '8' && (Number(b) < 8) === (p.group === 'solid'),
          ).length
          : null
        const isUp = game.winner == null && game.turn === i
        const shooter = isUp ? up : null
        const card = (
          <div
            key={p.name}
            className={`min-w-0 rounded-lg px-3 py-2 ${isUp ? 'bg-emerald-700 text-white' : 'bg-stone-200 dark:bg-stone-800'}`}
          >
            <div className="flex items-center gap-1.5 font-semibold">
              <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/20" style={{ background: SIDE_COLORS[i] }} aria-hidden="true" />
              <span className="truncate">{p.name}</span> {game.winner === i && '🏆'}
            </div>
            <div className="text-xs opacity-80">
              {p.group ? `${p.group}s · ${left} left` : 'open table'}
              {isUp && (shooter ? ` · ${shooter}’s shot` : ' · your shot')}
            </div>
          </div>
        )
        // The swap button sits between the two players
        return i === 0 ? [card, <SwapButton key="swap" onClick={onSwap} disabled={swapDisabled} />] : [card]
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

/** Full screen's photo button: the next photo without leaving the table view. */
function CameraButton({ label, onFile, disabled, busy }: {
  label: string
  onFile: (file: File) => void
  disabled: boolean
  busy: boolean
}) {
  return (
    <label
      aria-label={busy ? 'Reading the table…' : label}
      className={`flex h-14 w-20 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-emerald-700 text-white shadow-md focus-within:ring-4 focus-within:ring-emerald-400 active:bg-emerald-800 ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      {busy ? (
        <span className="size-6 animate-spin rounded-full border-[3px] border-white border-t-transparent" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      )}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = ''
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
  const [rosters, setRosters] = useState<Rosters>(null) // team mode; null = 1 vs 1
  const [hideTestTools, setHideTestTools] = useState(testToolsHidden)
  const [pendingRetake, setPendingRetake] = useState(false) // a retake shown but not applied until confirmed
  const [placing, setPlacing] = useState<number | null>(null) // ball taken out of the gutter, to put on the table

  const busy = status.kind === 'loading'
  const devMode = game?.id === DEV_GAME_ID

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
          setRosters(loadRosters(g.id))
          loadView(viewFromLayout(g))
        })
        .catch(() => localStorage.removeItem(GAME_KEY))
  }, [])

  const player = game ? game.players[game.turn] : null
  const turns = useMemo(() => (game ? teamTurns(game, rosters) : null), [game, rosters])
  const shooterName = turns?.up ?? player?.name // in team mode, the teammate who's up
  const gutter = useMemo(() => (game && turns ? gutterView(game, turns.byShot) : []), [game, turns])
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

  // Where the cue ball goes after hitting the selected shot's ball, from its physics plan:
  // the plan's path from the point nearest the ghost ball on (its start is the cue ball).
  const cueAfter = useMemo(() => {
    const path = plan && plan.shot === selectedShot ? plan.result?.physics?.cue_path : null
    if (!path || !selectedShot) return null
    const g = selectedShot.ghost
    let contact = 0
    path.forEach((p, i) => {
      if (Math.hypot(p.x - g.x, p.y - g.y) < Math.hypot(path[contact].x - g.x, path[contact].y - g.y)) contact = i
    })
    return [g, ...path.slice(contact + 1)]
  }, [plan, selectedShot])

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
    setPlacing(null)
    setPendingRetake(false)
    setSelected(0)
    resetCoach()
  }

  async function start(names: [string, string], teams: Rosters) {
    const g = await run('Starting…', () => createGame(names))
    if (!g) return
    try {
      localStorage.setItem(GAME_KEY, g.id)
    } catch {
      /* resuming after reload just won't work */
    }
    saveRosters(g.id, teams)
    setGame(g)
    setRosters(teams)
    loadView(null)
  }

  function loadTestTable(teams: boolean) {
    const g = mockGame(teams)
    setGame(g)
    setRosters(teams ? MOCK_ROSTERS : null)
    setStatus({ kind: 'idle' })
    loadView({ ...structuredClone(MOCK_TABLE), missing: [], rejected: [], shot: null, game: g })
  }

  // The gutter is the backend's record of what's pocketed: fixing it also takes a ball off
  // the table, or puts one back. Unsaved layout edits are kept; the coach starts over.
  async function saveGutter(next: GutterEntry[], change?: TableChange) {
    if (!game || busy) return
    if (pendingRetake) {
      setStatus({ kind: 'error', message: 'Confirm the retaken photo first: until then the gutter is from before it.' })
      return
    }
    let saved: Ball[] | null = serverBalls && change ? changeTable(serverBalls, change) : serverBalls
    if (devMode) {
      setGame(withGutter(game, next))
    } else {
      const res = await run('Saving the gutter…', () =>
        correctPocketed(game.id, next, change && saved ? toLayout(saved) : null),
      )
      if (!res) return
      setGame(res.game)
      if (change && saved) saved = res.balls
    }
    if (!change || !view) return
    setView({ ...view, balls: view.balls === serverBalls ? (saved ?? view.balls) : changeTable(view.balls, change) })
    setServerBalls(saved)
    setHistory(EMPTY_HISTORY) // undo can't bring back a ball that's in the gutter now
    setConfirmed(false)
    resetCoach()
  }

  function setWho(ball: number, by: 0 | 1 | null, member: string | null) {
    if (game) saveGutter(game.gutter.map(e => (e.ball === ball ? { ...e, by, member } : e)))
  }

  function addToGutter(ball: number) {
    if (!game) return
    const entry: GutterEntry = { ball, by: null, member: null, photo: null, open: false }
    saveGutter([...game.gutter, entry], view?.balls.some(b => b.id === ball) ? { off: ball } : undefined)
  }

  // Back on the table: with a photo, they tap where it is first; without one, there's nowhere to put it.
  function removeFromGutter(ball: number) {
    if (!game) return
    if (view) setPlacing(ball)
    else saveGutter(game.gutter.filter(e => e.ball !== ball))
  }

  // A ball from the gutter goes back on the table (saved); a loose one is a layout edit.
  function placeBall(x: number, y: number) {
    if (!game || !view || placing == null) return
    const ball: Ball =
      placing === 0
        ? { id: null, type: 'cue', x, y, confidence: 1 }
        : { id: placing, type: ballType(placing), x, y, confidence: 1 }
    setPlacing(null)
    if (game.gutter.some(e => e.ball === placing)) saveGutter(game.gutter.filter(e => e.ball !== placing), { on: ball })
    else commit(changeTable(view.balls, { on: ball }))
  }

  // Every photo after the first shows the result of the shot before it: the backend
  // works out what went in by comparing it with the previous photo.
  async function handlePhoto(file: File, retake: boolean) {
    if (!game) return
    if (pendingRetake && !retake) {
      setStatus({ kind: 'error', message: 'Confirm the retaken photo first (or retake it again).' })
      return
    }
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
    // A retake comes back unapplied: the game as it was before the bad photo, until confirmed
    setGame(res.game)
    loadView(res)
    setPendingRetake(!!res.pending)
  }

  // The photos got the turn wrong: the player switches it by hand.
  async function swapTurn() {
    if (!game || busy || game.winner != null) return
    if (pendingRetake) {
      setStatus({ kind: 'error', message: 'Confirm the retaken photo first.' })
      return
    }
    const turn = game.turn === 0 ? 1 : 0
    if (devMode) setGame({ ...game, turn })
    else {
      const g = await run('Switching turns…', () => setTurn(game.id, turn))
      if (!g) return
      setGame(g)
    }
    // Shots and advice were for the other player
    setConfirmed(false)
    resetCoach()
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
    if (loose.length) {
      setStatus({ kind: 'error', message: 'Every ball has to be on the table or in the gutter. Tap the ones marked ? to say where.' })
      return
    }
    let current = view
    let currentGame = game
    // A retake is only applied now (the backend replays it in place of the bad photo)
    if (!devMode && (view.balls !== serverBalls || pendingRetake)) {
      const res = await run('Saving your fixes…', () => correctLayout(game.id, toLayout(view.balls)))
      if (!res) return
      current = res
      currentGame = res.game
      setGame(res.game)
      setView(res)
      setServerBalls(res.balls)
      setPendingRetake(false)
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

  function showTestTools(show: boolean) {
    setHideTestTools(!show)
    try {
      if (show) localStorage.removeItem(TEST_TOOLS_KEY)
      else localStorage.setItem(TEST_TOOLS_KEY, 'hidden')
    } catch {
      /* hidden until the next reload, then */
    }
  }

  function newGame() {
    try {
      localStorage.removeItem(GAME_KEY)
    } catch {
      /* nothing to forget */
    }
    setGame(null)
    setRosters(null)
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
  // Every ball is on the table or in the gutter; these are neither (0 = the cue ball).
  const onTable = new Set(view?.balls.map(b => (b.type === 'cue' ? 0 : b.id)) ?? [])
  const loose = view ? Array.from({ length: 16 }, (_, n) => n).filter(n => !onTable.has(n) && !sunk.has(n)) : []

  const gutterPanel = (compact = false) =>
    game && (
      <Gutter
        game={game}
        rosters={rosters}
        balls={gutter}
        loose={loose}
        compact={compact}
        onSetWho={setWho}
        onRemove={removeFromGutter}
        onAdd={addToGutter}
        onPlace={setPlacing}
      />
    )

  return (
    <main className="min-h-dvh bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <Banner
        onNewGame={game ? newGame : undefined}
        onShowTestTools={import.meta.env.DEV && hideTestTools ? () => showTestTools(true) : undefined}
      />
      <div className="mx-auto max-w-2xl px-4 py-5 flex flex-col gap-5">
        <h1 className="sr-only">PocketIQ</h1>
        <p className="-mb-2 text-sm text-stone-600 dark:text-stone-400">
          After every shot, once the balls stop, snap the whole table before anyone touches it.
        </p>

        {status.kind === 'error' && (
          <p role="alert" className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {status.message}
          </p>
        )}

        {!game && <Setup onStart={start} busy={busy} />}

        {/* Dev only: skip the camera + backend and load a canned table */}
        {import.meta.env.DEV && !hideTestTools && (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            {[false, true].map(teams => (
              <button
                key={String(teams)}
                type="button"
                onClick={() => loadTestTable(teams)}
                className="rounded-xl border border-dashed border-stone-400 px-3 py-2 text-sm font-semibold text-stone-600 dark:text-stone-400"
              >
                {teams ? 'Test table (teams)' : 'Load test table'}
              </button>
            ))}
            {/* Bring them back from the menu */}
            <button
              type="button"
              aria-label="Hide test tools"
              onClick={() => showTestTools(false)}
              className="flex size-10 items-center justify-center self-center rounded-lg text-stone-500 active:bg-stone-200 dark:active:bg-stone-800"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}

        {game && (
          <>
            <Scoreboard
              game={game}
              up={turns?.up ?? null}
              onSwap={swapTurn}
              swapDisabled={busy || game.winner != null}
            />

            {pendingRetake ? (
              <p className="rounded-lg bg-amber-100 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
                <span className="font-semibold">Retake:</span> the game is back to before the last photo. Check this
                layout and confirm it to replace that photo; nothing changes until you do.
              </p>
            ) : view?.shot ? (
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
                    : photoCount === 0 ? 'Photo of the table' : `Photo after ${shooterName}’s shot`
                }
              />
            )}
            {(photoCount > 0 || pendingRetake) && (
              <PhotoButton disabled={busy} onFile={f => handlePhoto(f, true)} label="Retake the last photo" />
            )}

            {/* No table to show yet (or the game's over): the gutter goes where it would be */}
            {!(view && game.winner == null) && gutterPanel()}

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
                  className="table-stage relative"
                  style={{ '--table-aspect': (view.table.width + RAIL * 2) / (view.table.height + RAIL * 2) } as React.CSSProperties}
                >
                  <div className="stage-main">
                    <TableCanvas
                      data={view}
                      shots={shown.map(i => shots[i])}
                      selected={shown.indexOf(selected)}
                      cueAfter={cueAfter}
                      showConfidence={!confirmed}
                      highlight={picking}
                      onBallTap={confirmed ? undefined : onBallTap}
                      onShotTap={confirmed ? i => setSelected(shown[i]) : undefined}
                      onTableTap={placing == null ? undefined : placeBall}
                      turnColor={game.winner == null ? SIDE_COLORS[game.turn] : null}
                    />
                    <div className="stage-gutter">{gutterPanel(true)}</div>
                  </div>
                  {placing != null && (
                    <div className="absolute inset-x-0 top-2 z-10 flex justify-center px-2">
                      <p role="status" className="flex items-center gap-3 rounded-full bg-stone-950/85 py-1.5 pr-1.5 pl-4 text-sm font-semibold text-white shadow-lg">
                        Tap where the {placing === 0 ? 'cue ball' : placing} is
                        <button
                          type="button"
                          onClick={() => setPlacing(null)}
                          className="rounded-full bg-white/15 px-3 py-1.5 active:bg-white/25"
                        >
                          Cancel
                        </button>
                      </p>
                    </div>
                  )}
                  {/* The page's error message is hidden behind full screen: repeat it here */}
                  {status.kind === 'error' && placing == null && (
                    <div className="stage-only absolute inset-x-0 top-2 z-10 flex justify-center px-2">
                      <p role="alert" className="flex max-w-md items-center gap-3 rounded-2xl bg-red-900/95 py-1.5 pr-1.5 pl-4 text-sm font-medium text-white shadow-lg">
                        {status.message}
                        <button
                          type="button"
                          onClick={() => setStatus({ kind: 'idle' })}
                          className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 font-semibold active:bg-white/25"
                        >
                          OK
                        </button>
                      </p>
                    </div>
                  )}
                  <div className="stage-tools">
                    {confirmed ? (
                      <ShotGuide vertical guide={guide} />
                    ) : (
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
                    )}
                    <CameraButton
                      busy={busy && status.what === 'Reading the table…'}
                      disabled={busy}
                      label={photoCount === 0 ? 'Photo of the table' : `Photo after ${shooterName}’s shot`}
                      onFile={f => handlePhoto(f, false)}
                    />
                  </div>
                </div>

                {gutterPanel()}

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
          current={view.balls[picking].type === 'cue' ? 0 : view.balls[picking].id}
          unavailable={sunk}
          onPick={onPick}
          onClose={() => setPicking(null)}
        />
      )}
    </main>
  )
}

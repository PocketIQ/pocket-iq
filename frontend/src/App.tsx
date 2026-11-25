import { useEffect, useMemo, useState } from 'react'
import { analyzeGamePhoto, correctLayout, correctPocketed, createGame, getGame, planShot, setTurn } from './api'
import type { PlanResponse } from './api'
import { BallPicker } from './BallPicker'
import { Banner } from './Banner'
import { EditToolbar } from './EditToolbar'
import { startEngine, useEngine } from './engine/engine'
import { Gutter } from './Gutter'
import { gutterView, withGutter } from './gutterBalls'
import { MOCK_ROSTERS, MOCK_TABLE, mockGame } from './mockTable'
import { offlineReady } from './offline'
import { photoPixels } from './photoPixels'
import { findShots, type Shot } from './physics/shots'
import { Setup } from './Setup'
import { ShotGuide } from './ShotGuide'
import { guideFromPlan, placeholderGuide } from './spinPower'
import { RAIL, TableCanvas } from './TableCanvas'
import { loadRosters, saveRosters, SIDE_COLORS, teamTurns, type Rosters } from './teams'
import type { Tool } from './EditToolbar'
import type { Ball, Game, GameAnalyzeResponse, GutterEntry, IntendedShot, LayoutBall, ShotEvent } from './types'

type Status = { kind: 'idle' } | { kind: 'loading'; what: string } | { kind: 'error'; message: string }

type History = { past: Ball[][]; future: Ball[][] }

const EMPTY_HISTORY: History = { past: [], future: [] }

const GAME_KEY = 'cueiq.game' // resume the game after a reload
const SHOTS_SHOWN = 3
// Photo buttons open the camera. For testing without a table, ?upload lets phones pick a saved photo.
const CAPTURE = new URLSearchParams(location.search).has('upload') ? undefined : 'environment'
const READING = 'Reading the table…'

const DEV_GAME_ID = 'dev' // the test table's game: never saved
/** A photo not saved yet. `intended`: the shot they went for, sent when it's confirmed. */
type Pending = { mode: 'new' | 'replace'; intended: IntendedShot | null }

const NOTHING_HELD = { gutter: null, turn: null }
const TEST_TOOLS_KEY = 'cueiq.testTools' // "hidden" = the test table buttons are tucked away

function testToolsHidden(): boolean {
  try {
    return localStorage.getItem(TEST_TOOLS_KEY) === 'hidden'
  } catch {
    return false
  }
}

/** What confirming a layout sends: identities only, the game derives types. */
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
    // CAPTURE opens the rear camera on phones; on laptops it's a file picker
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
        capture={CAPTURE}
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
        capture={CAPTURE}
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

/** The last game, resumed after a reload. */
function savedGame(): Game | null {
  try {
    const id = localStorage.getItem(GAME_KEY)
    return id ? getGame(id) : null
  } catch {
    return null // storage blocked: just start fresh
  }
}

export default function App() {
  const [resumed] = useState(savedGame)
  const [resumedView] = useState(() => resumed && viewFromLayout(resumed))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [game, setGame] = useState<Game | null>(resumed)
  const [view, setView] = useState<GameAnalyzeResponse | null>(resumedView)
  const [serverBalls, setServerBalls] = useState<Ball[] | null>(resumedView?.balls ?? null) // the layout the saved game has
  const [selected, setSelected] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [tool, setTool] = useState<Tool>('label')
  const [picking, setPicking] = useState<number | null>(null)
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)
  // Physics plan (spin and power) and the shot it's for: a stale one is simply not shown.
  const [plan, setPlan] = useState<{ shot: Shot; result: PlanResponse | null } | null>(null)
  const [rosters, setRosters] = useState<Rosters>(() => resumed && loadRosters(resumed.id)) // team mode; null = 1 vs 1
  const [hideTestTools, setHideTestTools] = useState(testToolsHidden)
  // The photo just taken (new, or a retake of the latest): shown but not saved until confirmed
  const [pending, setPending] = useState<Pending | null>(null)
  // Gutter and turn fixes made while checking a retake: sent once confirming applies it
  const [held, setHeld] = useState<{ gutter: GutterEntry[] | null; turn: 0 | 1 | null }>(NOTHING_HELD)
  const [placing, setPlacing] = useState<number | null>(null) // ball taken out of the gutter, to put on the table

  const engine = useEngine()
  const busy = status.kind === 'loading'
  const devMode = game?.id === DEV_GAME_ID

  // Get the table reader ready while they set up, so the first photo doesn't wait for it.
  useEffect(() => {
    offlineReady().then(startEngine)
  }, [])

  const player = game ? game.players[game.turn] : null
  const turns = useMemo(() => (game ? teamTurns(game, rosters) : null), [game, rosters])
  const shooterName = turns?.up ?? player?.name // in team mode, the teammate who's up
  const gutter = useMemo(() => (game && turns ? gutterView(game, turns.byShot) : []), [game, turns])
  const shots = useMemo(
    () => (view && player && confirmed ? findShots(view.balls, view.table, view.ball_radius, player.group) : []),
    [view, player, confirmed],
  )

  // Spin and power come from the physics engine, for whichever shot is selected.
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

  const shown = shots.slice(0, SHOTS_SHOWN).map((_, i) => i)

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    setStatus({ kind: 'loading', what })
    try {
      const out = await fn()
      setStatus({ kind: 'idle' })
      return out
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }

  // A fresh layout from a photo or a fix: back to editing it.
  function loadView(next: GameAnalyzeResponse | null) {
    setView(next)
    setServerBalls(next?.balls ?? null)
    setConfirmed(false)
    setHistory(EMPTY_HISTORY)
    setPicking(null)
    setPlacing(null)
    setPending(null)
    setHeld(NOTHING_HELD)
    setSelected(0)
  }

  async function start(names: [string, string], teams: Rosters) {
    const g = await run('Starting…', async () => createGame(names))
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

  // The gutter is the game's record of what's pocketed: fixing it also takes a ball off
  // the table, or puts one back. Unsaved layout edits are kept.
  async function saveGutter(next: GutterEntry[], change?: TableChange) {
    if (!game || busy) return
    let saved: Ball[] | null = serverBalls && change ? changeTable(serverBalls, change) : serverBalls
    // The test table is never saved, and a photo isn't saved until confirmed: both change it here only
    if (devMode || pending) {
      setGame(withGutter(game, next))
      if (pending) setHeld(h => ({ ...h, gutter: next }))
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

  // Every photo after the first shows the result of the shot before it: the game
  // works out what went in by comparing it with the previous photo. Nothing is saved until
  // the layout is confirmed, so a bad photo can be retaken as often as needed.
  async function handlePhoto(file: File, retake: boolean) {
    if (!game) return
    // While a photo is waiting, any new one redoes it. Otherwise the shot selected on screen
    // is the one they went for: it's what counts as made or missed. A retake
    // of a saved photo keeps what was sent with it.
    const shot = shots[selected]
    const next: Pending = pending ?? {
      mode: retake ? 'replace' : 'new',
      intended: !retake && shot?.targetId != null
        ? { target: shot.targetId, pocket: shot.pocket, kind: shot.kind, cut_angle: shot.cutAngle }
        : null,
    }
    const res = await run(READING, async () =>
      analyzeGamePhoto(game.id, await photoPixels(file), { intended: next.intended, retake: next.mode === 'replace' }),
    )
    if (!res) return
    setGame(res.game) // what the game would be with this photo; the saved one hasn't changed
    loadView(res)
    setPending(next)
  }

  // The photos got the turn wrong: the player switches it by hand.
  async function swapTurn() {
    if (!game || busy || game.winner != null) return
    const turn = game.turn === 0 ? 1 : 0
    if (devMode || pending) {
      setGame({ ...game, turn })
      if (pending) setHeld(h => ({ ...h, turn }))
    } else {
      const g = await run('Switching turns…', () => setTurn(game.id, turn))
      if (!g) return
      setGame(g)
    }
    // Shots were for the other player
    setConfirmed(false)
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
  }

  // Save any fixes (the photo is replayed, so the detected shot, groups and turn can
  // change), then show shots.
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
    // A photo is only saved now: as the next one, or in place of the latest (a retake)
    if (!devMode && (view.balls !== serverBalls || pending)) {
      const res = await run('Saving your fixes…', async () => {
        const out = await correctLayout(game.id, toLayout(view.balls), pending?.intended ?? null, pending?.mode === 'new')
        // Then what they fixed while checking a retake, on top of the replayed photo
        if (held.gutter) out.game = (await correctPocketed(game.id, held.gutter, null)).game
        if (held.turn != null) out.game = await setTurn(game.id, held.turn)
        return out
      })
      if (!res) return
      setGame(res.game)
      setView(res)
      setServerBalls(res.balls)
      setPending(null)
      setHeld(NOTHING_HELD)
    }
    setStatus({ kind: 'idle' })
    setConfirmed(true)
    setSelected(0)
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
  const reading = busy && status.what === READING
  const readingLabel = engine.kind === 'loading' ? `Getting ready… ${Math.round(engine.fraction * 100)}%` : READING
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
        {status.kind === 'error' && (
          <p role="alert" className="rounded-lg bg-red-100 px-4 py-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">
            {status.message}
          </p>
        )}

        {!game && <Setup onStart={start} busy={busy} />}

        {/* Dev only: skip the camera and load a canned table */}
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

            {pending && (
              <p className="px-1 text-sm text-amber-700 dark:text-amber-300">
                <span className="font-semibold">Not saved yet.</span> Check the table and gutter, retake if it’s
                wrong, then confirm.
              </p>
            )}
            {view?.shot ? (
              <p className="px-1 text-sm">
                <span className="font-semibold">Last shot:</span> {describeShot(view.shot)}.
                {!pending && <span className="text-stone-500"> Wrong? Fix the layout or retake the photo.</span>}
              </p>
            ) : (
              view &&
              photoCount > 1 && (
                <p className="px-1 text-sm text-stone-600 dark:text-stone-400">
                  Nothing moved since the last photo, so no shot was recorded.
                </p>
              )
            )}

            {/* While a photo waits, the only photo button is Retake */}
            {pending ? null : game.winner != null ? (
              <p className="rounded-xl bg-emerald-100 px-4 py-3 text-center text-lg font-semibold text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100">
                {game.players[game.winner].name} wins!
              </p>
            ) : (
              <PhotoButton
                primary
                disabled={busy}
                onFile={f => handlePhoto(f, false)}
                label={
                  reading
                    ? readingLabel
                    : photoCount === 0 ? 'Photo of the table' : `Photo after ${shooterName}’s shot`
                }
              />
            )}
            {(photoCount > 0 || pending) && (
              <PhotoButton
                disabled={busy}
                onFile={f => handlePhoto(f, true)}
                label={reading && pending ? readingLabel : pending ? 'Retake photo' : 'Retake the last photo'}
              />
            )}

            {/* No table to show yet (or the game's over): the gutter goes where it would be */}
            {!(view && (game.winner == null || pending)) && gutterPanel()}

            {view && (game.winner == null || pending) && (
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
                      busy={reading}
                      disabled={busy}
                      label={photoCount === 0 ? 'Photo of the table' : `Photo after ${shooterName}’s shot`}
                      onFile={f => handlePhoto(f, false)}
                    />
                  </div>
                </div>

                {gutterPanel()}

                {!confirmed ? (
                  <>
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

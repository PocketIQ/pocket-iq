import { useState, type ReactNode } from 'react'
import { BallIcon } from './BallIcon'
import { BallPicker } from './BallPicker'
import type { GutterBall, GutterEdits } from './gutterBalls'
import { Sheet } from './Sheet'
import { SIDE_COLORS, type Rosters } from './teams'
import type { Game } from './types'

function Chip({ active, color, onClick, children }: {
  active: boolean
  color?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
        active
          ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900'
          : 'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300'
      }`}
    >
      {color && <span className="size-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />}
      {children}
    </button>
  )
}

function GutterSlot({ entry, onClick }: { entry: GutterBall; onClick: () => void }) {
  const color = entry.side == null ? null : SIDE_COLORS[entry.side]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Ball ${entry.ball}${entry.member ? `, ${entry.member}` : ''}${entry.wrong ? ', opponent’s ball' : ''}. Edit`}
      className="relative flex size-10 shrink-0 items-center justify-center rounded-full"
    >
      <BallIcon n={entry.ball} className="size-8" />
      {color && (
        <span
          className={`absolute inset-0 rounded-full border-[3px] ${entry.wrong ? 'border-dashed' : ''}`}
          style={{ borderColor: color }}
          aria-hidden="true"
        />
      )}
      {/* Team mode: the teammate who pocketed it */}
      {color && entry.member && (
        <span
          className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-stone-950 ring-2 ring-stone-900"
          style={{ background: color }}
          aria-hidden="true"
        >
          {entry.member[0]?.toUpperCase()}
        </span>
      )}
    </button>
  )
}

/** The pocketed balls, in order, in a ball-return gutter. Tap one to fix detection mistakes. */
export function Gutter({ game, rosters, balls, edits, onEdits }: {
  game: Game
  rosters: Rosters
  balls: GutterBall[]
  edits: GutterEdits
  onEdits: (edits: GutterEdits) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const entry = balls.find(g => g.ball === editing)

  function setWho(ball: number, side: 0 | 1 | null, member: string | null) {
    onEdits({ ...edits, set: { ...edits.set, [ball]: { side, member } } })
  }

  function remove(ball: number) {
    onEdits({
      ...edits,
      added: edits.added.filter(b => b !== ball),
      removed: edits.added.includes(ball) ? edits.removed : [...edits.removed, ball],
    })
    setEditing(null)
  }

  function add(ball: number) {
    onEdits({ ...edits, added: [...edits.added, ball], removed: edits.removed.filter(b => b !== ball) })
    setAdding(false)
    setEditing(ball) // straight to "who pocketed it?"
  }

  const inGutter = new Set(balls.map(g => g.ball))

  return (
    <section aria-label="Pocketed balls" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 overflow-x-auto rounded-full border border-stone-700 bg-gradient-to-b from-stone-950 to-stone-800 px-2 py-1.5 shadow-[inset_0_3px_8px_rgba(0,0,0,0.75)]">
        {balls.length === 0 && <span className="px-2 text-xs text-stone-400">No balls pocketed yet</span>}
        {balls.map(g => (
          <GutterSlot key={g.ball} entry={g} onClick={() => setEditing(g.ball)} />
        ))}
        <button
          type="button"
          aria-label="Add a pocketed ball"
          onClick={() => setAdding(true)}
          className="ml-auto flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-stone-600 text-xl text-stone-400 active:bg-stone-800"
        >
          +
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-stone-500">
        {game.players.map((p, i) => (
          <span key={p.name} className="flex items-center gap-1">
            <span className="size-2.5 rounded-full" style={{ background: SIDE_COLORS[i] }} aria-hidden="true" />
            {p.name}
          </span>
        ))}
        <span>dashed = opponent’s ball · no ring = break</span>
      </p>

      {entry && (
        <Sheet title={`Ball ${entry.ball}`} onClose={() => setEditing(null)}>
          <div className="flex flex-col gap-3 pb-1">
            <div className="flex justify-center">
              <BallIcon n={entry.ball} className="size-14" />
            </div>
            <p className="text-sm font-medium">Pocketed by</p>
            <div className="grid grid-cols-3 gap-1">
              {game.players.map((p, i) => (
                <Chip
                  key={p.name}
                  active={entry.side === i}
                  color={SIDE_COLORS[i]}
                  onClick={() => setWho(entry.ball, i as 0 | 1, rosters?.[i][0] ?? null)}
                >
                  <span className="truncate">{p.name}</span>
                </Chip>
              ))}
              <Chip active={entry.side == null} onClick={() => setWho(entry.ball, null, null)}>
                No one
              </Chip>
            </div>
            {entry.side == null && <p className="text-xs text-stone-500">No ring: went in on the break, or doesn’t count for anyone.</p>}
            {entry.wrong && <p className="text-xs text-amber-700 dark:text-amber-300">That’s the other side’s ball, so its ring is dashed.</p>}

            {rosters && entry.side != null && (
              <>
                <p className="text-sm font-medium">Which teammate?</p>
                <div className="flex flex-wrap gap-1">
                  {rosters[entry.side].map(m => (
                    <Chip key={m} active={entry.member === m} onClick={() => setWho(entry.ball, entry.side, m)}>
                      {m}
                    </Chip>
                  ))}
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => remove(entry.ball)}
              className="mt-1 min-h-11 rounded-lg px-3 py-2 text-sm font-semibold text-red-700 active:bg-red-50 dark:text-red-400 dark:active:bg-red-950"
            >
              Not pocketed: remove from gutter
            </button>
          </div>
        </Sheet>
      )}

      {adding && (
        <BallPicker
          title="Which ball went in?"
          unavailable={new Set([0, ...inGutter])}
          onPick={add}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  )
}

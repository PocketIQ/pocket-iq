import { useState, type ReactNode } from 'react'
import { BallIcon } from './BallIcon'
import { BallPicker } from './BallPicker'
import type { GutterBall } from './gutterBalls'
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

const ballName = (n: number) => (n === 0 ? 'cue ball' : `${n}`)

function GutterSlot({ entry, compact, onClick }: { entry: GutterBall; compact: boolean; onClick: () => void }) {
  const color = entry.side == null ? null : SIDE_COLORS[entry.side]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Ball ${entry.ball}${entry.member ? `, ${entry.member}` : ''}${entry.wrong ? ', opponent’s ball' : ''}. Edit`}
      className={`relative flex shrink-0 items-center justify-center rounded-full ${compact ? 'size-7' : 'size-10'}`}
    >
      <BallIcon n={entry.ball} className={compact ? 'size-5' : 'size-8'} />
      {color && (
        <span
          className={`absolute inset-0 rounded-full ${compact ? 'border-2' : 'border-[3px]'} ${entry.wrong ? 'border-dashed' : ''}`}
          style={{ borderColor: color }}
          aria-hidden="true"
        />
      )}
      {/* Team mode: the teammate who pocketed it */}
      {color && entry.member && (
        <span
          className={`absolute -right-1 -bottom-1 flex items-center justify-center rounded-full font-bold text-stone-950 ring-2 ring-stone-900 ${
            compact ? 'size-3 text-[7px]' : 'size-4 text-[9px]'
          }`}
          style={{ background: color }}
          aria-hidden="true"
        >
          {entry.member[0]?.toUpperCase()}
        </span>
      )}
    </button>
  )
}

/**
 * The pocketed balls in a ball-return gutter, newest first. Tap one to fix detection
 * mistakes: who it counts for, or that it isn't pocketed at all. + adds one that was missed.
 * `loose`: balls that are neither on the table nor in the gutter (missed by the camera, or
 * removed by hand), shown next to + until the player says where they are.
 * `compact`: the thin strip under the table in full screen.
 */
export function Gutter({ game, rosters, balls, loose, compact = false, onSetWho, onRemove, onAdd, onPlace }: {
  game: Game
  rosters: Rosters
  balls: GutterBall[]
  loose: number[]
  compact?: boolean
  onSetWho: (ball: number, side: 0 | 1 | null, member: string | null) => void
  onRemove: (ball: number) => void // back on the table
  onAdd: (ball: number) => void // off the table
  onPlace: (ball: number) => void // a loose ball: put it on the table
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [locating, setLocating] = useState<number | null>(null) // a loose ball: where is it?
  const entry = balls.find(g => g.ball === editing)

  function remove(ball: number) {
    onRemove(ball)
    setEditing(null)
  }

  function add(ball: number) {
    onAdd(ball)
    setAdding(false)
    setEditing(ball) // straight to "who pocketed it?"
  }

  const inGutter = new Set(balls.map(g => g.ball))

  return (
    <section aria-label="Pocketed balls" className="flex flex-col gap-1.5">
      <div
        className={`flex items-center overflow-x-auto rounded-full border border-stone-700 bg-stone-900 ${
          compact ? 'gap-0.5 px-1 py-0.5' : 'gap-1 px-2 py-1.5'
        }`}
      >
        <button
          type="button"
          aria-label="Add a pocketed ball"
          onClick={() => setAdding(true)}
          className={`flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-stone-600 text-stone-400 active:bg-stone-800 ${
            compact ? 'size-7 text-base' : 'size-10 text-xl'
          }`}
        >
          +
        </button>
        {loose.map(n => (
          // Not on the table and not in the gutter: tap to say where it is
          <button
            key={`loose-${n}`}
            type="button"
            aria-label={`Where is the ${ballName(n)}?`}
            onClick={() => setLocating(n)}
            className={`relative flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-amber-400 ${
              compact ? 'size-7' : 'size-10'
            }`}
          >
            <BallIcon n={n} className={`opacity-60 ${compact ? 'size-5' : 'size-8'}`} />
            <span
              className={`absolute -top-1 -right-1 flex items-center justify-center rounded-full bg-amber-400 font-bold text-stone-950 ${
                compact ? 'size-3 text-[8px]' : 'size-4 text-[10px]'
              }`}
              aria-hidden="true"
            >
              ?
            </span>
          </button>
        ))}
        {loose.length > 0 && balls.length > 0 && <span className="mx-1 h-6 w-px shrink-0 bg-stone-700" aria-hidden="true" />}
        {balls.length === 0 && loose.length === 0 && (
          <span className="px-2 text-xs text-stone-400">No balls pocketed yet</span>
        )}
        {[...balls].reverse().map(g => (
          <GutterSlot key={g.ball} entry={g} compact={compact} onClick={() => setEditing(g.ball)} />
        ))}
      </div>
      {!compact && loose.length > 0 && (
        <p className="px-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
          Where {loose.length === 1 ? 'is' : 'are'} the {loose.map(ballName).join(', ')}? Tap to put{' '}
          {loose.length === 1 ? 'it' : 'each'} on the table or in the gutter.
        </p>
      )}

      {locating != null && (
        <Sheet title={`Where’s the ${ballName(locating)}?`} onClose={() => setLocating(null)}>
          <div className="flex flex-col gap-2 pb-1">
            <div className="flex justify-center">
              <BallIcon n={locating} className="size-14" />
            </div>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              It isn’t on the table or in the gutter. Every ball has to be one or the other.
            </p>
            <button
              type="button"
              onClick={() => {
                onPlace(locating)
                setLocating(null)
              }}
              className="min-h-11 rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white active:bg-emerald-800"
            >
              On the table: tap where it is
            </button>
            {/* The cue ball never stays down: after a scratch it comes back out */}
            {locating !== 0 && (
              <button
                type="button"
                onClick={() => {
                  add(locating)
                  setLocating(null)
                }}
                className="min-h-11 rounded-xl bg-stone-200 px-4 py-3 font-semibold active:bg-stone-300 dark:bg-stone-800 dark:active:bg-stone-700"
              >
                It was pocketed
              </button>
            )}
          </div>
        </Sheet>
      )}

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
                  onClick={() => onSetWho(entry.ball, i as 0 | 1, rosters?.[i][0] ?? null)}
                >
                  <span className="truncate">{p.name}</span>
                </Chip>
              ))}
              <Chip active={entry.side == null} onClick={() => onSetWho(entry.ball, null, null)}>
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
                    <Chip key={m} active={entry.member === m} onClick={() => onSetWho(entry.ball, entry.side, m)}>
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
              Not pocketed: put it back on the table
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

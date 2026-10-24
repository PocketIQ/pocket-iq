import { BallIcon } from './BallIcon'
import { Sheet } from './Sheet'

/** 0 is the cue ball, 1-15 the numbered balls. */
const PICKABLE = Array.from({ length: 16 }, (_, n) => n)

export function BallPicker({ current = null, unavailable, onPick, onClose, title = 'Which ball is this?' }: {
  /** The ball's label right now (0 = cue), highlighted. */
  current?: number | null
  /** Balls that can't be picked, e.g. already pocketed this game. */
  unavailable: Set<number>
  onPick: (n: number) => void
  onClose: () => void
  title?: string
}) {
  return (
    <Sheet title={title} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-1 landscape:grid-cols-8">
        {PICKABLE.map(n => (
          <button
            key={n}
            type="button"
            aria-label={n === 0 ? 'Cue ball' : `Ball ${n}${unavailable.has(n) ? ', unavailable' : ''}`}
            aria-pressed={n === current}
            disabled={unavailable.has(n)}
            onClick={() => onPick(n)}
            className={`flex h-14 items-center justify-center rounded-xl active:bg-stone-200 disabled:opacity-25 dark:active:bg-stone-800 ${
              n === current ? 'bg-emerald-100 ring-2 ring-emerald-500 dark:bg-emerald-950' : ''
            }`}
          >
            <BallIcon n={n} />
          </button>
        ))}
      </div>
    </Sheet>
  )
}

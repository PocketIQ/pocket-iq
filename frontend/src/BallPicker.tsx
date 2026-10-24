import { BALL_COLORS } from './ballColors'
import type { Ball } from './types'

/** 0 is the cue ball, 1-15 the numbered balls. */
const PICKABLE = Array.from({ length: 16 }, (_, n) => n)

function BallIcon({ n }: { n: number }) {
  const color = n === 0 ? '#f8f6ef' : n === 8 ? '#141414' : BALL_COLORS[((n - 1) % 8) + 1]
  const stripe = n > 8
  return (
    <svg viewBox="0 0 40 40" className="size-10" aria-hidden="true">
      <defs>
        <clipPath id={`pick-clip-${n}`}>
          <circle cx="20" cy="20" r="18" />
        </clipPath>
      </defs>
      <circle cx="20" cy="20" r="18" fill={stripe ? '#f8f6ef' : color} />
      {stripe && <rect x="0" y="10" width="40" height="20" fill={color} clipPath={`url(#pick-clip-${n})`} />}
      <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1.5" />
      {n > 0 && (
        <>
          <circle cx="20" cy="20" r="8" fill="#fff" />
          <text x="20" y="20.5" textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="700" fill="#111">
            {n}
          </text>
        </>
      )}
    </svg>
  )
}

export function BallPicker({ ball, onPick, onClose }: { ball: Ball; onPick: (n: number) => void; onClose: () => void }) {
  const current = ball.type === 'cue' ? 0 : ball.id

  return (
    // Bottom sheet in portrait, centered card in landscape so it fits the short screen.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 landscape:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Which ball is this?"
        className="w-full max-w-md rounded-t-2xl bg-white px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] text-stone-900 landscape:w-auto landscape:max-w-none landscape:rounded-2xl landscape:pb-3 dark:bg-stone-900 dark:text-stone-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Which ball is this?</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 flex size-11 items-center justify-center rounded-lg text-stone-500 active:bg-stone-200 dark:active:bg-stone-800"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1 landscape:grid-cols-8">
          {PICKABLE.map((n) => (
            <button
              key={n}
              type="button"
              aria-label={n === 0 ? 'Cue ball' : `Ball ${n}`}
              aria-pressed={n === current}
              onClick={() => onPick(n)}
              className={`flex h-14 items-center justify-center rounded-xl active:bg-stone-200 dark:active:bg-stone-800 ${
                n === current ? 'bg-emerald-100 ring-2 ring-emerald-500 dark:bg-emerald-950' : ''
              }`}
            >
              <BallIcon n={n} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

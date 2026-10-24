import type { Guide } from './spinPower'

function CueBall({ spin, size }: { spin: Guide['spin']; size: string }) {
  // Keep the dot inside the ball's face even at full offset.
  const cx = 30 + spin.x * 18
  const cy = 30 + spin.y * 18
  return (
    <svg viewBox="0 0 60 60" className={size} role="img" aria-label="Where to hit the cue ball">
      <circle cx="30" cy="30" r="27" fill="#f8f6ef" stroke="rgba(0,0,0,0.35)" strokeWidth="1.5" />
      {/* Crosshair so center, follow and draw are easy to read */}
      <path d="M30 6v48M6 30h48" stroke="rgba(0,0,0,0.12)" strokeWidth="1" />
      <circle cx="30" cy="30" r="13.5" fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="5" fill="#dc2626" stroke="#7f1d1d" strokeWidth="1" />
    </svg>
  )
}

function PowerBar({ power, vertical }: { power: number; vertical: boolean }) {
  const pct = `${Math.round(Math.min(1, Math.max(0, power)) * 100)}%`
  return (
    <div
      className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400 ${
        vertical ? 'flex-col-reverse' : 'w-full'
      }`}
    >
      <span>Soft</span>
      <div
        role="meter"
        aria-label="Power"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(power * 100)}
        className={`relative rounded-full ${
          vertical
            ? 'h-32 w-3 bg-gradient-to-t from-emerald-500 via-amber-400 to-red-600'
            : 'h-3 flex-1 bg-gradient-to-r from-emerald-500 via-amber-400 to-red-600'
        }`}
      >
        {/* Marker: a ring that sits on the bar at the suggested power */}
        <span
          className={`absolute size-5 rounded-full border-[3px] border-stone-900 bg-white shadow dark:border-white dark:bg-stone-900 ${
            vertical ? 'left-1/2 -translate-x-1/2 translate-y-1/2' : 'top-1/2 -translate-x-1/2 -translate-y-1/2'
          }`}
          style={vertical ? { bottom: pct } : { left: pct }}
        />
      </div>
      <span>Hard</span>
    </div>
  )
}

/** Cue ball contact point and power, in the toolbar's spot once the layout is confirmed. */
export function ShotGuide({ guide, vertical = false }: { guide: Guide; vertical?: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl bg-stone-200 p-2 dark:bg-stone-800 ${
        vertical ? 'w-20 flex-col gap-2 py-3' : ''
      }`}
    >
      <CueBall spin={guide.spin} size={vertical ? 'size-14' : 'size-12 shrink-0'} />
      <div className={`flex min-w-0 flex-col gap-1.5 ${vertical ? 'items-center' : 'flex-1'}`}>
        <PowerBar power={guide.power} vertical={vertical} />
        <span
          className={`text-center text-[11px] font-semibold capitalize leading-tight text-stone-700 dark:text-stone-300 ${
            vertical ? '' : 'text-left'
          }`}
        >
          {guide.label}
        </span>
      </div>
    </div>
  )
}

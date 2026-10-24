import { useState } from 'react'
import { BallIcon } from './BallIcon'
import { Sheet } from './Sheet'

// The standard 8-ball rack, front (foot spot) to back.
const RACK = [[1], [9, 6], [2, 8, 14], [10, 7, 15, 5], [3, 11, 12, 4, 13]]

function RackDiagram() {
  return (
    <div className="flex flex-col items-center gap-3">
      {/* The balls packed in a triangle, apex (the foot spot) at the top */}
      <div className="flex flex-col items-center py-2" role="img" aria-label={`Rack, front to back: ${RACK.map(r => r.join(' ')).join(', ')}`}>
        {RACK.map((row, i) => (
          <div key={i} className="-mt-1 flex first:mt-0">
            {row.map(n => (
              <BallIcon key={n} n={n} className="size-10" />
            ))}
          </div>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 self-stretch text-sm text-stone-700 dark:text-stone-300">
        <li>• The <b>1</b> goes at the front, on the foot spot.</li>
        <li>• The <b>8</b> goes in the middle of the third row.</li>
        <li>• Back corners: one solid and one stripe (here the 3 and the 13).</li>
        <li>• Push the balls together so they all touch, then lift the rack straight up.</li>
      </ul>
    </div>
  )
}

function ProfileSheet() {
  return (
    <div className="flex flex-col items-center gap-3 pb-1 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-stone-200 text-2xl font-bold text-stone-600 dark:bg-stone-800 dark:text-stone-300">
        G
      </div>
      <div>
        <p className="font-semibold">Guest</p>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          You’re playing as a guest. Profiles and saved stats are coming soon.
        </p>
      </div>
      <button
        type="button"
        disabled
        className="w-full rounded-xl bg-stone-200 px-5 py-3 font-semibold text-stone-500 dark:bg-stone-800"
      >
        Sign in · coming soon
      </button>
    </div>
  )
}

function MenuItem({ label, detail, onClick }: { label: string; detail?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left active:bg-stone-100 dark:active:bg-stone-800"
    >
      <span className="font-medium">{label}</span>
      {detail && <span className="text-sm text-stone-500">{detail}</span>}
    </button>
  )
}

/** App bar: name, New game, and the menu (profile, how to rack). */
export function Banner({ onNewGame }: { onNewGame?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheet, setSheet] = useState<'profile' | 'rack' | null>(null)

  function open(which: 'profile' | 'rack') {
    setMenuOpen(false)
    setSheet(which)
  }

  return (
    <>
      <header className="sticky top-0 z-40 bg-emerald-800 pt-[env(safe-area-inset-top)] text-white shadow-md">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center justify-between gap-2 px-4">
          <span className="text-xl font-bold tracking-tight">PocketIQ</span>
          <div className="flex items-center gap-1">
            {onNewGame && (
              <button
                type="button"
                onClick={onNewGame}
                className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold active:bg-white/25"
              >
                New game
              </button>
            )}
            <button
              type="button"
              aria-label="Menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
              className="-mr-2 flex size-11 items-center justify-center rounded-lg active:bg-white/15"
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          </div>

          {menuOpen && (
            <>
              {/* Tap anywhere else to close */}
              <button type="button" aria-label="Close menu" className="fixed inset-0 cursor-default" onClick={() => setMenuOpen(false)} />
              <div
                role="menu"
                className="absolute top-full right-2 mt-1 w-56 rounded-xl bg-white p-1 text-stone-900 shadow-lg ring-1 ring-black/5 dark:bg-stone-900 dark:text-stone-100 dark:ring-white/10"
              >
                <MenuItem label="Profile" detail="Guest" onClick={() => open('profile')} />
                <MenuItem label="How to rack" onClick={() => open('rack')} />
              </div>
            </>
          )}
        </div>
      </header>

      {sheet === 'profile' && (
        <Sheet title="Profile" onClose={() => setSheet(null)}>
          <ProfileSheet />
        </Sheet>
      )}
      {sheet === 'rack' && (
        <Sheet title="How to rack" onClose={() => setSheet(null)}>
          <RackDiagram />
        </Sheet>
      )}
    </>
  )
}

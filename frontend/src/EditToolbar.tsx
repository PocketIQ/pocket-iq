import type { ReactNode } from 'react'

export type Tool = 'flip' | 'cue' | 'eight' | 'remove'

const TOOLS: { value: Tool; label: string; icon: ReactNode }[] = [
  {
    value: 'flip',
    label: 'Solid/Stripe',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <defs>
          <clipPath id="tool-flip-clip">
            <circle cx="12" cy="12" r="9" />
          </clipPath>
        </defs>
        <circle cx="12" cy="12" r="9" fill="#f8f6ef" />
        <g clipPath="url(#tool-flip-clip)">
          <rect x="0" y="0" width="12" height="24" fill="#d62828" />
          <rect x="12" y="7" width="12" height="10" fill="#d62828" />
        </g>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    value: 'cue',
    label: 'Cue',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#f8f6ef" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    value: 'eight',
    label: '8 ball',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#141414" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="4.5" fill="#fff" />
        <text x="12" y="12.5" textAnchor="middle" dominantBaseline="middle" fontSize="6" fontWeight="700" fill="#111">8</text>
      </svg>
    ),
  },
  {
    value: 'remove',
    label: 'Remove',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" />
      </svg>
    ),
  },
]

function HistoryButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-lg text-stone-700 active:bg-stone-300 disabled:opacity-30 dark:text-stone-300 dark:active:bg-stone-700"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

export function EditToolbar({
  tool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: Tool
  onToolChange: (tool: Tool) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-stone-200 p-1 dark:bg-stone-800">
      <div role="radiogroup" aria-label="Edit tool" className="grid flex-1 grid-cols-[1.4fr_1fr_1fr_1fr] gap-1">
        {TOOLS.map((option) => {
          const active = tool === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onToolChange(option.value)}
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-semibold leading-none ${
                active
                  ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-950 dark:text-stone-100'
                  : 'text-stone-600 dark:text-stone-400'
              }`}
            >
              {option.icon}
              <span className="whitespace-nowrap">{option.label}</span>
            </button>
          )
        })}
      </div>
      <div className="flex border-l border-stone-300 pl-1 dark:border-stone-700">
        <HistoryButton label="Undo" disabled={!canUndo} onClick={onUndo}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </HistoryButton>
        <HistoryButton label="Redo" disabled={!canRedo} onClick={onRedo}>
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
        </HistoryButton>
      </div>
    </div>
  )
}

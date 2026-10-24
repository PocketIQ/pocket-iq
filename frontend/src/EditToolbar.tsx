import type { ReactNode } from 'react'

export type Tool = 'label' | 'remove'

const TOOLS: { value: Tool; label: string; icon: ReactNode }[] = [
  {
    value: 'label',
    label: 'Set ball',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <defs>
          <clipPath id="tool-label-clip">
            <circle cx="12" cy="12" r="9" />
          </clipPath>
        </defs>
        <circle cx="12" cy="12" r="9" fill="#f8f6ef" />
        <g clipPath="url(#tool-label-clip)">
          <rect x="0" y="0" width="12" height="24" fill="#d62828" />
          <rect x="12" y="7" width="12" height="10" fill="#d62828" />
        </g>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
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
  vertical = false,
  onConfirm,
}: {
  tool: Tool
  onToolChange: (tool: Tool) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** Stacked column for the landscape full-screen view. */
  vertical?: boolean
  /** Shows a checkmark confirm button at the end of the toolbar. */
  onConfirm?: () => void
}) {
  return (
    <div className={`flex items-center gap-1 rounded-xl bg-stone-200 p-1 dark:bg-stone-800 ${vertical ? 'w-20 flex-col' : ''}`}>
      <div
        role="radiogroup"
        aria-label="Edit tool"
        className={`grid gap-1 ${vertical ? 'w-full grid-cols-1' : 'flex-1 grid-cols-2'}`}
      >
        {TOOLS.map((option) => {
          const active = tool === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onToolChange(option.value)}
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 font-semibold leading-none ${
                vertical ? 'text-[10px]' : 'text-[11px]'
              } ${
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
      <div
        className={`flex border-stone-300 dark:border-stone-700 ${vertical ? 'w-full justify-center border-t pt-1' : 'border-l pl-1'}`}
      >
        <HistoryButton label="Undo" disabled={!canUndo} onClick={onUndo}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </HistoryButton>
        <HistoryButton label="Redo" disabled={!canRedo} onClick={onRedo}>
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
        </HistoryButton>
      </div>
      {onConfirm && (
        <button
          type="button"
          aria-label="Confirm layout"
          onClick={onConfirm}
          className="flex h-11 w-full items-center justify-center rounded-lg bg-emerald-700 text-white active:bg-emerald-800"
        >
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 5 5 9-10" />
          </svg>
        </button>
      )}
    </div>
  )
}

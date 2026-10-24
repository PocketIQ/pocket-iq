import type { ReactNode } from 'react'

/** Pop-up panel: a bottom sheet in portrait, a centered card in landscape so it fits the short screen. */
export function Sheet({ title, onClose, children, wide = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  /** Let landscape grow to the content's width (e.g. the 8-across ball grid). */
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 landscape:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] text-stone-900 landscape:rounded-2xl landscape:pb-3 dark:bg-stone-900 dark:text-stone-100 ${
          wide ? 'landscape:w-auto landscape:max-w-none' : ''
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
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
        {children}
      </div>
    </div>
  )
}

import { useId } from 'react'
import { BALL_COLORS } from './ballColors'

/** A pool ball: 0 is the cue ball, 1-15 the numbered balls. */
export function BallIcon({ n, className = 'size-10' }: { n: number; className?: string }) {
  const clip = useId()
  const color = n === 0 ? '#f8f6ef' : n === 8 ? '#141414' : BALL_COLORS[((n - 1) % 8) + 1]
  const stripe = n > 8
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <circle cx="20" cy="20" r="18" />
        </clipPath>
      </defs>
      <circle cx="20" cy="20" r="18" fill={stripe ? '#f8f6ef' : color} />
      {stripe && <rect x="0" y="10" width="40" height="20" fill={color} clipPath={`url(#${clip})`} />}
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

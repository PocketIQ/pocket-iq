import { useEffect, useRef } from 'react'
import type { AnalyzeResponse, Ball } from './types'

// Standard pool ball colors, indexed by number (stripes reuse 1-7).
const BALL_COLORS: Record<number, string> = {
  1: '#f5c400', 2: '#1d4fd8', 3: '#d62828', 4: '#6b2fa3',
  5: '#f77f00', 6: '#1f8a4c', 7: '#7a1f1f',
}

function ballColor(b: Ball): string {
  if (b.type === 'cue') return '#f8f6ef'
  if (b.type === 'eight') return '#141414'
  if (b.id == null) return b.type === 'solid' ? '#888' : '#bbb'
  return BALL_COLORS[((b.id - 1) % 8) + 1] ?? '#888'
}

export function TableCanvas({ data }: { data: AnalyzeResponse }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = () => {
      const { width: TW, height: TH } = data.table
      const rail = 40 // table units of wood around the felt
      const cssW = canvas.clientWidth
      const s = cssW / (TW + rail * 2) // table units -> CSS pixels
      const cssH = (TH + rail * 2) * s

      // Draw at device resolution so it's sharp on retina phones.
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.height = `${cssH}px`

      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0) // from here on, draw in table units
      ctx.clearRect(0, 0, TW + rail * 2, TH + rail * 2)

      // Rails
      ctx.fillStyle = '#5a3418'
      ctx.beginPath()
      ctx.roundRect(0, 0, TW + rail * 2, TH + rail * 2, 24)
      ctx.fill()

      // Felt: everything below is offset by the rail
      ctx.translate(rail, rail)
      ctx.fillStyle = '#17643f'
      ctx.fillRect(0, 0, TW, TH)

      // Pockets: 4 corners + 2 side
      ctx.fillStyle = '#0a0a0a'
      for (const [px, py] of [[0, 0], [TW / 2, 0], [TW, 0], [0, TH], [TW / 2, TH], [TW, TH]]) {
        ctx.beginPath()
        ctx.arc(px, py, 22, 0, Math.PI * 2)
        ctx.fill()
      }

      // Balls
      const r = data.ball_radius
      for (const b of data.balls) {
        ctx.beginPath()
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
        if (b.type === 'stripe') {
          // White ball with a colored band
          ctx.fillStyle = '#f8f6ef'
          ctx.fill()
          ctx.save()
          ctx.clip()
          ctx.fillStyle = ballColor(b)
          ctx.fillRect(b.x - r, b.y - r * 0.55, r * 2, r * 1.1)
          ctx.restore()
        } else {
          ctx.fillStyle = ballColor(b)
          ctx.fill()
        }

        // Dashed ring = low confidence. The Correction UI will use this.
        ctx.lineWidth = 1.5
        ctx.setLineDash(b.confidence < 0.7 ? [4, 3] : [])
        ctx.strokeStyle = b.confidence < 0.7 ? '#ffd166' : 'rgba(0,0,0,0.5)'
        ctx.beginPath()
        ctx.arc(b.x, b.y, r + (b.confidence < 0.7 ? 4 : 0), 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])

        // Number label
        if (b.id != null && b.type !== 'cue') {
          ctx.fillStyle = b.type === 'eight' ? '#fff' : '#111'
          ctx.font = 'bold 10px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(b.id), b.x, b.y + 0.5)
        }
      }
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [data])

  return <canvas ref={ref} className="w-full block" />
}

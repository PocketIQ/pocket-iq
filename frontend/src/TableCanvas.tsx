import { useEffect, useRef } from 'react'
import type { AnalyzeResponse, Ball } from './types'
import type { Shot, Vec } from './physics/shots'

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

function polyline(ctx: CanvasRenderingContext2D, pts: Vec[]) {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
  ctx.stroke()
}

function drawShot(ctx: CanvasRenderingContext2D, shot: Shot, r: number, active: boolean) {
  ctx.globalAlpha = active ? 1 : 0.25
  ctx.lineCap = 'round'
  // Target ball's path: dashed yellow, through the bank point if there is one
  ctx.strokeStyle = '#ffd166'
  ctx.lineWidth = active ? 3 : 2
  ctx.setLineDash([10, 7])
  polyline(ctx, shot.targetPath)
  ctx.setLineDash([])
  // Cue ball's path: solid white, ending at the ghost ball
  ctx.strokeStyle = '#ffffff'
  polyline(ctx, shot.cuePath)
  // Ghost ball: where the cue ball sits at impact
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(shot.ghost.x, shot.ghost.y, r, 0, Math.PI * 2)
  ctx.stroke()
  if (shot.bankPoint) {
    ctx.fillStyle = '#ffd166'
    ctx.beginPath()
    ctx.arc(shot.bankPoint.x, shot.bankPoint.y, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

export function TableCanvas({
  data,
  shots = [],
  selected = 0,
}: {
  data: AnalyzeResponse
  shots?: Shot[]
  selected?: number
}) {
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

      const r = data.ball_radius

      // Shot lines go under the balls. Faded alternatives first, chosen shot on top.
      shots.forEach((sh, i) => i !== selected && drawShot(ctx, sh, r, false))
      if (shots[selected]) drawShot(ctx, shots[selected], r, true)

      // Balls
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
  }, [data, shots, selected])

  return <canvas ref={ref} className="w-full block" />
}

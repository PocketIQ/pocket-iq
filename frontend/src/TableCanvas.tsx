import { useEffect, useRef } from 'react'
import { BALL_COLORS } from './ballColors'
import type { Shot, Vec } from './physics/shots'
import type { AnalyzeResponse, Ball } from './types'

export const RAIL = 40 // table units of wood around the felt

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

/** A pointer position in table units. */
function toTable(data: AnalyzeResponse, canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  const s = rect.width / (data.table.width + 2 * RAIL)
  return { x: (clientX - rect.left) / s - RAIL, y: (clientY - rect.top) / s - RAIL }
}

/** Nearest ball to a pointer, in table units. 2 radii, then 3 if that misses. */
function ballIndexAt(data: AnalyzeResponse, canvas: HTMLCanvasElement, clientX: number, clientY: number): number | null {
  const { x: tx, y: ty } = toTable(data, canvas, clientX, clientY)
  const r = data.ball_radius

  let nearest = -1
  let nearestDist = Infinity
  for (let i = 0; i < data.balls.length; i++) {
    const ball = data.balls[i]
    const dist = Math.hypot(ball.x - tx, ball.y - ty)
    if (dist < nearestDist) {
      nearest = i
      nearestDist = dist
    }
  }
  if (nearest < 0) return null
  if (nearestDist <= 2 * r) return nearest
  if (nearestDist <= 3 * r) return nearest
  return null
}

type Press = {
  pointerId: number
  x: number
  y: number
  index: number
  moved: boolean
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
  showConfidence = true,
  highlight = null,
  onBallTap,
  onTableTap,
}: {
  data: AnalyzeResponse
  shots?: Shot[]
  selected?: number
  showConfidence?: boolean
  /** Index of a ball to ring, e.g. the one the ball picker is open for. */
  highlight?: number | null
  onBallTap?: (index: number) => void
  /** Tap anywhere on the cloth (wins over onBallTap), in table units: placing a ball. */
  onTableTap?: (x: number, y: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const press = useRef<Press | null>(null)

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || !(onBallTap || onTableTap)) return
    const canvas = ref.current
    if (!canvas) return
    const index = onTableTap ? -1 : ballIndexAt(data, canvas, e.clientX, e.clientY)
    if (index == null) return
    e.preventDefault()
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events have no pointer to capture.
    }
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, index, moved: false }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const current = press.current
    if (!current || current.pointerId !== e.pointerId || current.moved) return
    if (Math.hypot(e.clientX - current.x, e.clientY - current.y) > 10) current.moved = true
  }

  function endPress(e: React.PointerEvent<HTMLCanvasElement>, tap: boolean) {
    const current = press.current
    if (!current || current.pointerId !== e.pointerId) return
    press.current = null
    if (!tap || current.moved) return
    const canvas = ref.current
    if (onTableTap && canvas) {
      // Keep the whole ball on the cloth
      const { x, y } = toTable(data, canvas, e.clientX, e.clientY)
      const r = data.ball_radius
      const clamp = (v: number, max: number) => Math.min(Math.max(v, r), max - r)
      onTableTap(clamp(x, data.table.width), clamp(y, data.table.height))
    } else if (current.index >= 0) onBallTap?.(current.index)
  }

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = () => {
      const { width: TW, height: TH } = data.table
      const cssW = canvas.clientWidth
      const s = cssW / (TW + RAIL * 2) // table units -> CSS pixels
      const cssH = (TH + RAIL * 2) * s

      // Draw at device resolution so it's sharp on retina phones.
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.height = `${cssH}px`

      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0) // from here on, draw in table units
      ctx.clearRect(0, 0, TW + RAIL * 2, TH + RAIL * 2)

      // Rails
      ctx.fillStyle = '#5a3418'
      ctx.beginPath()
      ctx.roundRect(0, 0, TW + RAIL * 2, TH + RAIL * 2, 24)
      ctx.fill()

      // Felt: everything below is offset by the rail
      ctx.translate(RAIL, RAIL)
      ctx.fillStyle = '#17643f'
      ctx.fillRect(0, 0, TW, TH)

      // Diamonds: 3 evenly spaced sights between each pair of pockets, along the middle of the rails
      const mid = RAIL / 2
      const sights: [number, number, boolean][] = [] // x, y, on a long rail
      for (const k of [1, 2, 3, 5, 6, 7]) sights.push([(TW * k) / 8, -mid, true], [(TW * k) / 8, TH + mid, true])
      for (const k of [1, 2, 3]) sights.push([-mid, (TH * k) / 4, false], [TW + mid, (TH * k) / 4, false])
      ctx.fillStyle = '#d6d9de'
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 1
      for (const [x, y, long] of sights) {
        const [w, h] = long ? [9, 5] : [5, 9] // half-sizes, longer along the rail
        ctx.beginPath()
        ctx.moveTo(x - w, y)
        ctx.lineTo(x, y - h)
        ctx.lineTo(x + w, y)
        ctx.lineTo(x, y + h)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }

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

        // Low confidence stays a dashed ring, thicker and brighter so it reads on a phone.
        const low = showConfidence && b.confidence < 0.7
        ctx.lineWidth = low ? 5 : 1.5
        ctx.setLineDash(low ? [8, 5] : [])
        ctx.strokeStyle = low ? '#ffe14a' : 'rgba(0,0,0,0.5)'
        ctx.beginPath()
        ctx.arc(b.x, b.y, r + (low ? 6 : 0), 0, Math.PI * 2)
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

      const marked = highlight == null ? null : data.balls[highlight]
      if (marked) {
        ctx.strokeStyle = '#34d399'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.arc(marked.x, marked.y, r + 7, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Watch the canvas itself, not the window: rotating into landscape resizes it via CSS.
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [data, shots, selected, showConfidence, highlight])

  return (
    <canvas
      ref={ref}
      className="w-full block touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPress(e, true)}
      onPointerCancel={(e) => endPress(e, false)}
      onContextMenu={(e) => e.preventDefault()}
    />
  )
}

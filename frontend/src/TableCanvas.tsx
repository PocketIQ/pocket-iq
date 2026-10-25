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

/** A pointer position in table units, plus the CSS pixels per table unit. */
function toTable(data: AnalyzeResponse, canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  const s = rect.width / (data.table.width + 2 * RAIL)
  return { tx: (clientX - rect.left) / s - RAIL, ty: (clientY - rect.top) / s - RAIL, s }
}

/** Nearest ball to a pointer, in table units. 2 radii, then 3 if that misses. */
function ballIndexAt(data: AnalyzeResponse, canvas: HTMLCanvasElement, clientX: number, clientY: number): number | null {
  const { tx, ty } = toTable(data, canvas, clientX, clientY)
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

function distToSegment(px: number, py: number, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

const SHOT_HIT_PX = 22 // how close a finger has to land to a shot's line

/** The shot whose drawn lines (cue path or target path) are nearest the pointer, if close. */
function shotIndexAt(data: AnalyzeResponse, shots: Shot[], canvas: HTMLCanvasElement, clientX: number, clientY: number): number | null {
  const { tx, ty, s } = toTable(data, canvas, clientX, clientY)
  let nearest: number | null = null
  let nearestDist = SHOT_HIT_PX / s
  shots.forEach((shot, i) => {
    for (const path of [shot.cuePath, shot.targetPath]) {
      for (let k = 1; k < path.length; k++) {
        const dist = distToSegment(tx, ty, path[k - 1], path[k])
        if (dist < nearestDist) {
          nearest = i
          nearestDist = dist
        }
      }
    }
  })
  return nearest
}

type Press = {
  pointerId: number
  x: number
  y: number
  target: { kind: 'ball' | 'shot' | 'table'; index: number }
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

/** Where the line from the cue ball through the ghost ball meets the cushion (felt edge). */
function aimAtCushion(shot: Shot, W: number, H: number): Vec | null {
  const cue = shot.cuePath[0]
  const g = shot.ghost
  const dx = g.x - cue.x
  const dy = g.y - cue.y
  if (!dx && !dy) return null
  const tx = dx > 0 ? (W - g.x) / dx : dx < 0 ? -g.x / dx : Infinity
  const ty = dy > 0 ? (H - g.y) / dy : dy < 0 ? -g.y / dy : Infinity
  const t = Math.min(tx, ty)
  return { x: g.x + dx * t, y: g.y + dy * t }
}

/** The aiming line: straight on from the ghost ball to the cushion, grey dots, with a
 * mark on the cushion. Line the cue up with that spot on the rail. */
function drawAimLine(ctx: CanvasRenderingContext2D, shot: Shot, W: number, H: number) {
  const end = aimAtCushion(shot, W, H)
  if (!end) return
  ctx.strokeStyle = 'rgba(200,204,210,0.95)'
  ctx.fillStyle = 'rgba(200,204,210,0.95)'
  ctx.lineCap = 'round'
  ctx.lineWidth = 3.5
  ctx.setLineDash([0.1, 9]) // round caps on near-zero dashes draw dots
  polyline(ctx, [shot.ghost, end])
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(end.x, end.y, 6, 0, Math.PI * 2)
  ctx.fill()
}

/** Where the cue ball goes after contact (physics plan): faint white dashes, and a faint
 * ring where it stops. */
function drawCueAfter(ctx: CanvasRenderingContext2D, path: Vec[], r: number) {
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.lineCap = 'round'
  ctx.lineWidth = 2
  ctx.setLineDash([7, 6])
  polyline(ctx, path)
  const end = path[path.length - 1]
  ctx.setLineDash([3, 4])
  ctx.beginPath()
  ctx.arc(end.x, end.y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
}

export function TableCanvas({
  data,
  shots = [],
  selected = 0,
  cueAfter = null,
  showConfidence = true,
  highlight = null,
  onBallTap,
  onShotTap,
  onTableTap,
}: {
  data: AnalyzeResponse
  shots?: Shot[]
  selected?: number
  /** The selected shot's cue ball path after contact (from the physics plan), if known. */
  cueAfter?: Vec[] | null
  showConfidence?: boolean
  /** Index of a ball to ring, e.g. the one the ball picker is open for. */
  highlight?: number | null
  onBallTap?: (index: number) => void
  /** Tapping a shot's line: index into `shots`. Used when balls aren't editable. */
  onShotTap?: (index: number) => void
  /** Tap anywhere on the cloth (wins over onBallTap), in table units: placing a ball. */
  onTableTap?: (x: number, y: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const press = useRef<Press | null>(null)

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return
    const canvas = ref.current
    if (!canvas) return
    // Placing a ball: any tap on the cloth counts. Otherwise a ball, then a shot's line.
    const ball = !onTableTap && onBallTap ? ballIndexAt(data, canvas, e.clientX, e.clientY) : null
    const shot = !onTableTap && ball == null && onShotTap ? shotIndexAt(data, shots, canvas, e.clientX, e.clientY) : null
    const target = onTableTap
      ? { kind: 'table' as const, index: -1 }
      : ball != null ? { kind: 'ball' as const, index: ball } : shot != null ? { kind: 'shot' as const, index: shot } : null
    if (!target) return
    e.preventDefault()
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events have no pointer to capture.
    }
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, target, moved: false }
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
    if (current.target.kind === 'table') {
      if (!canvas || !onTableTap) return
      // Keep the whole ball on the cloth
      const { tx, ty } = toTable(data, canvas, e.clientX, e.clientY)
      const r = data.ball_radius
      const clamp = (v: number, max: number) => Math.min(Math.max(v, r), max - r)
      onTableTap(clamp(tx, data.table.width), clamp(ty, data.table.height))
    } else if (current.target.kind === 'ball') onBallTap?.(current.target.index)
    else onShotTap?.(current.target.index)
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
      if (shots[selected] && cueAfter && cueAfter.length > 1) drawCueAfter(ctx, cueAfter, r)
      if (shots[selected]) drawAimLine(ctx, shots[selected], TW, TH)

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
  }, [data, shots, selected, cueAfter, showConfidence, highlight])

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

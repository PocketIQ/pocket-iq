/**
 * The app's side of the worker: starts it, sends it requests, and knows how far it's
 * loaded. If it fails (no connection on the first visit, out of memory), the next request
 * starts a new one.
 */
import { useSyncExternalStore } from 'react'
import type { FromWorker, ToWorker } from './protocol'

export type EngineState =
  | { kind: 'loading'; fraction: number } // of the download
  | { kind: 'ready' }
  | { kind: 'failed' }

type Waiting = { resolve: (result: unknown) => void; reject: (err: Error) => void }

const LOAD_FAILED = 'Couldn’t load the table reader. Check your connection, reload, and try again.'
const CRASHED = 'Something went wrong reading that. Try again; if it keeps happening, close other apps and reload.'

// For testing on phones, where there's no console: ?upload shows what went wrong
const SHOW_DETAIL = new URLSearchParams(location.search).has('upload')
let detail = ''
const explain = (message: string) => (SHOW_DETAIL && detail ? `${message} [${detail}]` : message)

let worker: Worker | null = null
let state: EngineState = { kind: 'loading', fraction: 0 }
let nextId = 1
const waiting = new Map<number, Waiting>()
const listeners = new Set<() => void>()

function setState(next: EngineState) {
  state = next
  listeners.forEach(l => l())
}

/** Drop the worker and everything asked of it. */
function stop(message: string) {
  worker?.terminate()
  worker = null
  setState({ kind: 'failed' })
  for (const w of waiting.values()) w.reject(new Error(explain(message)))
  waiting.clear()
}

function onMessage(m: FromWorker) {
  if (m.kind === 'progress') {
    if (state.kind === 'loading') setState({ kind: 'loading', fraction: m.fraction })
  } else if (m.kind === 'ready') setState({ kind: 'ready' })
  else if (m.kind === 'failed') {
    console.error(m.message)
    detail = m.message
    if (m.rules) setState({ kind: 'failed' }) // turns and gutter fixes still work
    else stop(LOAD_FAILED)
  } else if ('crashed' in m) {
    // Its Python may be left in any state: start over
    if (!waiting.has(m.id)) return
    detail = m.crashed
    stop(CRASHED)
  } else {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if ('notLoaded' in m) w?.reject(new Error(explain(LOAD_FAILED)))
    else if ('error' in m) w?.reject(new Error(m.error))
    else w?.resolve(m.result)
  }
}

/** Start loading, if it isn't already. */
export function startEngine(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker = w
  setState({ kind: 'loading', fraction: 0 })
  w.onmessage = (e: MessageEvent<FromWorker>) => w === worker && onMessage(e.data)
  w.onerror = e => {
    e.preventDefault()
    if (w !== worker) return
    detail = e.message || 'worker error'
    stop(LOAD_FAILED)
  }
  return w
}

// Free its memory as the page goes, or a reload may not have enough. (Locking the phone or
// switching apps doesn't count as leaving.) If the page comes back, load again.
addEventListener('pagehide', () => worker && stop(CRASHED))
addEventListener('pageshow', e => e.persisted && startEngine())

type Request = Omit<Extract<ToWorker, { kind: 'call' }>, 'id'> | Omit<Extract<ToWorker, { kind: 'photo' }>, 'id'>

function send<T>(m: Request, transfer: Transferable[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // The photo reader didn't load last time: try again
    if (m.kind === 'photo' && state.kind === 'failed' && waiting.size === 0) {
      worker?.terminate()
      worker = null
    }
    const w = startEngine()
    const id = nextId++
    waiting.set(id, { resolve: r => resolve(r as T), reject })
    w.postMessage({ ...m, id }, transfer)
  })
}

/** One of local.py's calls. */
export const call = <T>(name: string, args: object) => send<T>({ kind: 'call', name, args: JSON.stringify(args) })

/** Read a photo. Its pixels are handed over, not copied. */
export const readPhoto = <T>(photo: ImageData, args: object) =>
  send<T>(
    { kind: 'photo', rgba: photo.data.buffer as ArrayBuffer, width: photo.width, height: photo.height, args: JSON.stringify(args) },
    [photo.data.buffer as ArrayBuffer],
  )

export function useEngine(): EngineState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

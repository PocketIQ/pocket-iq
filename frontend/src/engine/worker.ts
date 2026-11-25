/**
 * Runs the backend's Python (backend/local.py) and the ball detector, off the main thread.
 * Two stages: the rules and physics are ready first; the photo reader (OpenCV and the
 * detector) follows, and only photos wait for it.
 */
import type { FromWorker, ToWorker } from './protocol'

// Pyodide and ONNX Runtime are plain files in public/engine, loaded at run time: just the
// bits used here are typed.
interface PyProxy {
  destroy(): void
}
interface FloatArray extends PyProxy {
  getBuffer(type: 'f32'): { data: Float32Array; release(): void }
}
interface LocalPy {
  call(name: string, args: string): string
  start_photo(rgba: Uint8Array, w: number, h: number): string
  photo_input(i: number): FloatArray
  finish_photo(outputs: PyProxy, shape: PyProxy, args: string): string
}
interface Pyodide {
  FS: { writeFile(path: string, text: string): void }
  loadPackage(names: string[]): Promise<unknown>
  pyimport(name: 'local'): LocalPy
  toPy(value: unknown): PyProxy
}
interface Tensor {
  dims: readonly number[]
  getData(): Promise<Float32Array>
  dispose(): void
}
interface Session {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>
}
interface Ort {
  env: { wasm: { wasmPaths: string; numThreads: number } }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor
  InferenceSession: { create(model: Uint8Array, options: object): Promise<Session> }
}

const ENGINE = new URL('/engine/', self.location.origin).href
const PY_FILES = ['game.py', 'physics.py', 'vision.py', 'local.py']
const THREADS = 4

const post = (m: FromWorker) => self.postMessage(m)

// ------------------------------------------------------------------ downloads
// Count what's downloaded, and fix the type of .wasm files: hosts like Cloudflare Pages
// send them without one, and browsers then refuse to run them.
let total = 0
let loaded = 0
const realFetch = self.fetch.bind(self)
self.fetch = async (...args: Parameters<typeof fetch>) => {
  const res = await realFetch(...args)
  const path = new URL(res.url || String(args[0]), self.location.href).pathname
  if (!res.ok || !res.body || !path.startsWith('/engine/')) return res
  // A host may answer a missing file with the app's page
  if (res.headers.get('content-type')?.includes('text/html')) throw new Error(`Missing file: ${path}`)
  const headers = new Headers(res.headers)
  if (path.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm')
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength
      if (total) post({ kind: 'progress', fraction: Math.min(1, loaded / total) })
      controller.enqueue(chunk)
    },
  }))
  return new Response(counted, { status: res.status, headers })
}

async function get(path: string): Promise<Response> {
  const res = await fetch(ENGINE + path)
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`)
  return res
}

// ------------------------------------------------------------------ memory
// Memory shared between threads reserves its maximum up front. ONNX Runtime asks for 4 GB,
// which iPhones may refuse ("Out of memory"), above all while a page just closed still
// holds its own. It needs a small part of that.
const SHARED_MAX_PAGES = (512 * 2 ** 20) / 2 ** 16
WebAssembly.Memory = new Proxy(WebAssembly.Memory, {
  construct(Memory, [descriptor]: [WebAssembly.MemoryDescriptor]) {
    if (!descriptor.shared) return new Memory(descriptor)
    const maximum = Math.max(descriptor.initial, Math.min(descriptor.maximum ?? SHARED_MAX_PAGES, SHARED_MAX_PAGES))
    return new Memory({ ...descriptor, maximum })
  },
})

// ------------------------------------------------------------------ loading
// Pyodide only logs it when its wasm can't start, then waits forever
const startupFailure = new Promise<never>((_, reject) => {
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warn(...args)
    if (args.some(a => String(a).includes('wasm instantiation failed'))) reject(new Error('Python could not start'))
  }
})
startupFailure.catch(() => {})

// Which step of loading this is, for the error if it fails
let step = 'start'

async function loadRules() {
  const sizes: Record<string, number> = await (await get('sizes.json')).json()
  // Scripts (.mjs) are imported, not fetched, so they aren't counted
  total = Object.entries(sizes).reduce((sum, [f, n]) => (f.endsWith('.mjs') ? sum : sum + n), 0)
  step = 'Python'
  const { loadPyodide } = await import(/* @vite-ignore */ ENGINE + 'pyodide/pyodide.mjs')
  const py: Pyodide = await Promise.race([
    loadPyodide({ indexURL: ENGINE + 'pyodide/', stdout: () => {}, stderr: () => {} }),
    startupFailure,
  ])
  const sources = await Promise.all(PY_FILES.map(async f => (await get('py/' + f)).text()))
  PY_FILES.forEach((f, i) => py.FS.writeFile('/home/pyodide/' + f, sources[i]))
  return { py, local: py.pyimport('local') }
}

async function loadPhotoReader() {
  const { py, local } = await rules
  step = 'OpenCV'
  await py.loadPackage(['numpy', 'opencv-python'])
  step = 'ONNX Runtime'
  const ort: Ort = await import(/* @vite-ignore */ ENGINE + 'ort/ort.wasm.min.mjs')
  ort.env.wasm.wasmPaths = ENGINE + 'ort/'
  // Several threads need the page to be isolated (public/_headers)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(THREADS, navigator.hardwareConcurrency || 1) : 1
  step = 'ball detector'
  const model = new Uint8Array(await (await get('balls.onnx')).arrayBuffer())
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  post({ kind: 'ready' })
  return { py, local, ort, session }
}

const rules = loadRules()
const photoReader = loadPhotoReader()
photoReader.catch(async err => {
  const rulesOk = await rules.then(() => true, () => false)
  post({ kind: 'failed', message: `${step}: ${err}`, rules: rulesOk })
})

// ------------------------------------------------------------------ requests
function unpack(json: string): { result: unknown } | { error: string } {
  return JSON.parse(json)
}

let photos: Promise<unknown> = Promise.resolve() // one photo at a time

async function readPhoto({ rgba, width, height, args }: Extract<ToWorker, { kind: 'photo' }>) {
  const reader = await photoReader.catch(() => null)
  if (!reader) return { notLoaded: true as const }
  const { py, local, ort, session } = reader
  const start: { error: string } | { inputs: number; size: number } =
    JSON.parse(local.start_photo(new Uint8Array(rgba), width, height))
  if ('error' in start) return start
  const outputs: Float32Array[] = []
  let shape: number[] = []
  for (let i = 0; i < start.inputs; i++) {
    const array = local.photo_input(i)
    const view = array.getBuffer('f32')
    const data = new Float32Array(view.data) // a copy: Python's memory can move
    view.release()
    array.destroy()
    const input = new ort.Tensor('float32', data, [1, 3, start.size, start.size])
    const output = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]]
    shape = [...output.dims]
    outputs.push(new Float32Array(await output.getData()))
    input.dispose()
    output.dispose()
  }
  const pyOutputs = py.toPy(outputs)
  const pyShape = py.toPy(shape)
  try {
    return unpack(local.finish_photo(pyOutputs, pyShape, args))
  } finally {
    pyOutputs.destroy()
    pyShape.destroy()
  }
}

async function answer(m: ToWorker) {
  if (m.kind === 'call') return unpack((await rules).local.call(m.name, m.args))
  const job = photos.then(() => readPhoto(m))
  photos = job.catch(() => {})
  return job
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const { id } = e.data
  try {
    post({ kind: 'answer', id, ...(await answer(e.data)) })
  } catch (err) {
    console.error(err) // a bug or out of memory: the details are for us, not the player
    post({ kind: 'answer', id, crashed: String(err) })
  }
}

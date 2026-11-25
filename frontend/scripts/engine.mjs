// Puts together public/engine: everything the app needs to run the Python on the phone.
//   - Pyodide (Python), NumPy and OpenCV for it, and ONNX Runtime: downloaded once, from
//     jsDelivr, at exact versions checked against the hashes below
//   - the backend's own Python, and the ball detector
// Runs before dev and build. Restart dev after changing the Python.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'engine')
const backend = join(root, '..', 'backend')

const NPM = 'https://cdn.jsdelivr.net/npm/'
const PYODIDE = NPM + 'pyodide@314.0.8/'
const WHEELS = 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/'
const ORT = NPM + 'onnxruntime-web@1.31.1/dist/'
const LIBRARIES = [
  ['pyodide', PYODIDE, 'pyodide.mjs', '1bb8cc14f9405aaa7cd4e00c12edd0a8539de9cc026618d6ee5a9663f367dc70'],
  ['pyodide', PYODIDE, 'pyodide.asm.mjs', '22514b8be6980e28a02c8b1d6387ce8dfe666fc4edf8d547cff5dce29ff4d972'],
  ['pyodide', PYODIDE, 'pyodide.asm.wasm', 'e14d49ceca9b4a0e274ea918f3a898de2d3880b6e5573a6cfe1a2267ecc70329'],
  ['pyodide', PYODIDE, 'python_stdlib.zip', '2bd3394a145bfbbe5bbc9d9d6ab9136abbb986c6fef6c142b3a2962227aa5c28'],
  ['pyodide', PYODIDE, 'pyodide-lock.json', '5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010'],
  ['pyodide', WHEELS, 'numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl', 'a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf'],
  ['pyodide', WHEELS, 'opencv_python-4.11.0.86-cp314-cp314-pyemscripten_2026_0_wasm32.whl', '469a8ba6758ec4e0bce12436da977a1db3a953e320927c3f55ca6233a5d20acf'],
  ['ort', ORT, 'ort.wasm.min.mjs', 'c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234'],
  ['ort', ORT, 'ort-wasm-simd-threaded.mjs', '30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3'],
  ['ort', ORT, 'ort-wasm-simd-threaded.wasm', '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d'],
]
const PYTHON = ['game.py', 'physics.py', 'vision.py', 'local.py']

const sha256 = data => createHash('sha256').update(data).digest('hex')

for (const [dir, base, name, hash] of LIBRARIES) {
  const file = join(out, dir, name)
  if (existsSync(file) && sha256(readFileSync(file)) === hash) continue
  const res = await fetch(base + name)
  if (!res.ok) throw new Error(`Couldn't download ${base + name}: ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  if (sha256(data) !== hash) throw new Error(`${name} isn't the file we expect (its hash changed)`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log('engine: downloaded', name)
}

mkdirSync(join(out, 'py'), { recursive: true })
for (const name of PYTHON) copyFileSync(join(backend, name), join(out, 'py', name))
copyFileSync(join(backend, 'models', 'balls.onnx'), join(out, 'balls.onnx'))

// What the app downloads, for its progress bar
const files = [...LIBRARIES.map(([dir, , name]) => `${dir}/${name}`), ...PYTHON.map(n => `py/${n}`), 'balls.onnx']
const sizes = Object.fromEntries(files.map(f => [f, statSync(join(out, f)).size]))
writeFileSync(join(out, 'sizes.json'), JSON.stringify(sizes))

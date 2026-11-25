import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

// The same as public/_headers: lets the ball detector use several threads
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

/** Writes dist/sw.js from src/sw.js, listing every file of the build with its hash. */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    closeBundle() {
      const dist = join(import.meta.dirname, 'dist')
      const files: Record<string, string> = {}
      for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
        const file = join(entry.parentPath, entry.name)
        const path = '/' + relative(dist, file).replaceAll('\\', '/')
        if (!entry.isFile() || ['/sw.js', '/_headers', '/.DS_Store'].includes(path)) continue
        files[path === '/index.html' ? '/' : path] = createHash('sha256').update(readFileSync(file)).digest('hex')
      }
      const source = readFileSync(join(import.meta.dirname, 'src/sw.js'), 'utf8')
      writeFileSync(join(dist, 'sw.js'), source.replace('__FILES__', JSON.stringify(files)))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  worker: { format: 'es' },
  server: { host: true, headers }, // phones need https (README.md)
  preview: { headers },
})

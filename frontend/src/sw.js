// Service worker: keeps the app on the phone so it opens and works offline. vite.config.ts
// fills in FILES at build time: every file of this version, with its hash.
// The app itself is saved at install. The engine (big) is saved as the app loads it.
const FILES = __FILES__ // { path: sha256 }
const CACHE = 'pocketiq'

const keyOf = path => `${path}?v=${FILES[path]}`
const isEngine = path => path.startsWith('/engine/')

async function matches(path, res) {
  if (!res.ok) return false
  if (path === '/') return true // a host may add to the page
  const digest = await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer())
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') === FILES[path]
}

/** This version's file, saved for next time. Anything else (a newer version, an error page) isn't kept. */
async function download(path, cache) {
  const res = await fetch(path, { cache: 'reload' })
  const good = await matches(path, res)
  if (good) await cache.put(keyOf(path), res.clone()).catch(() => {}) // out of space: still usable now
  return { res, good }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(Object.keys(FILES).filter(p => !isEngine(p)).map(async path => {
      if (await cache.match(keyOf(path))) return
      const { good } = await download(path, cache)
      if (!good) throw new Error(`${path} isn't this version's`)
    }))
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const keep = new Set(Object.keys(FILES).map(keyOf))
    for (const req of await cache.keys()) {
      const { pathname, search } = new URL(req.url)
      if (!keep.has(pathname + search)) await cache.delete(req)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data === 'activate') self.skipWaiting()
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== location.origin) return
  const path = event.request.mode === 'navigate' ? '/' : url.pathname
  if (!(path in FILES)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const saved = await cache.match(keyOf(path))
    if (saved) return saved
    const { res, good } = await download(path, cache)
    // Never mix versions of the engine
    if (!good && isEngine(path)) return new Response('A newer version is out', { status: 409 })
    return res
  })())
})

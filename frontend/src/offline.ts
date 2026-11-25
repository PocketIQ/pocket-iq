/**
 * Registers the service worker (sw.js), which keeps the app and its engine on the phone.
 * Resolves once it's in charge, so the engine's files are downloaded through it and kept.
 */
const WAIT_MS = 4000 // don't hold the app up: without it, everything still works online

export async function offlineReady(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  try {
    const inCharge = new Promise<void>(resolve => {
      sw.addEventListener('controllerchange', () => resolve(), { once: true })
    })
    const reg = await sw.register('/sw.js')
    if (reg.waiting && sw.controller) {
      // A newer version came in last time: switch to it now, before anything starts
      const switched = inCharge.then(() => location.reload())
      reg.waiting.postMessage('activate')
      await Promise.race([switched, new Promise(r => setTimeout(r, WAIT_MS))])
    } else if (!sw.controller) {
      await Promise.race([inCharge, new Promise(r => setTimeout(r, WAIT_MS))])
    }
    // Ask the browser not to clear saved games and files when space runs low
    void navigator.storage?.persist?.().catch(() => {})
  } catch {
    /* private window, storage blocked: online only */
  }
}

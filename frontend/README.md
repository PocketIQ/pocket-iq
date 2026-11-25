# PocketIQ app

React + TypeScript + Vite. There's no server: the Python in `../backend` runs in the browser.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # dist/, what Cloudflare Pages hosts
npm run lint
```

- `scripts/engine.mjs` runs before dev and build. It fills `public/engine` (not in git) with
  Pyodide, NumPy, OpenCV and ONNX Runtime (downloaded once, checked against their hashes)
  plus the backend's Python and ball detector. **Restart dev after changing the Python.**
- `src/engine/` runs it all in a worker; `src/api.ts` is what the app calls.
- `src/sw.js` keeps the app and the engine on the phone, so it works offline (builds only).
- `public/_headers` lets the detector use several threads on Cloudflare Pages.

**Phones need https.** Over `http://<laptop-ip>:5173` Safari runs it dozens of times slower.
Test on a phone with a Cloudflare Pages preview.

Cloudflare Pages: root directory `frontend`, build command `npm run build`, output `dist`.

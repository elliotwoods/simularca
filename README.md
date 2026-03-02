# Simularca

Desktop-first simulation environment for kinetic art pre-visualization.

## Stack
- Electron + Vite + React + TypeScript
- Three.js WebGPU renderer
- Optional dedicated Gaussian splat renderer overlay (`@mkkellogg/gaussian-splats-3d`) with fallback path
- GoldenLayout paneling
- Tweakpane inspector
- Zustand + Immer state model with undo/redo

## Run
1. `npm install`
2. `npm run dev`

Default dev URL is `http://localhost:5180`.
If you only want browser mode: `npm run dev:web`.
If you only want Electron (assuming Vite is already running): `npm run dev:electron`.

## Runtime Diagnostics
- Start app + live runtime log tail:
  - `npm run dev:diag`
- Show recent Electron/runtime errors:
  - `npm run logs:show`
- Live tail:
  - `npm run logs:tail`

Runtime logs are written to:
- `logs/electron-runtime.log`

This captures:
- Electron startup/load failures
- renderer process crashes
- preload errors
- renderer `window.error` and `unhandledrejection`
- console errors (warning/error levels)

Note:
- Electron preload script is `electron/preload.cjs` (CommonJS) for compatibility with dev runtime loading.

## Build
- Web build (read-only): `npm run build`
- Electron TS compile: `npm run build:electron`

## Session Paths
- `savedata/defaults.json`
- `savedata/<sessionName>/session.json`
- `savedata/<sessionName>/assets/...`

## HDRI Transcoding Requirement
HDRI import uses `toktx` for KTX2 generation. Ensure `toktx` is installed and on your `PATH`.
For runtime KTX2 decode, place basis transcoder files in `public/basis/` (e.g. `basis_transcoder.js`, `basis_transcoder.wasm`).

## Notes
- Web mode (`public/sessions/...`) is read-only and intended for future Vercel deploys.
- Gaussian splat actor now supports a dedicated overlay path (when module is installed) and falls back to `.ply` point cloud rendering otherwise.
- Plugin sample package: `plugins/example-wave-plugin`.
- Plugin handshake contract and loader expectations: `docs/plugin-handshake.md`.

## Optional Dedicated Splat Renderer
To enable dedicated Gaussian splat rendering:
1. `npm install @mkkellogg/gaussian-splats-3d`
2. Restart dev server.

If the module is unavailable, the app auto-falls back to the built-in PLY point cloud path.

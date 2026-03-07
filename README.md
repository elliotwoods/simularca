# Simularca

Desktop-first simulation environment for kinetic art pre-visualization.

## Stack
- Electron + Vite + React + TypeScript
- Three.js WebGPU renderer
- Native in-scene Gaussian splat renderer (single path)
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

## Project Paths
- `savedata/defaults.json`
- `savedata/<projectName>/snapshots/<snapshotName>.json`
- `savedata/<projectName>/assets/...`
- legacy compatibility: `savedata/<projectName>/session.json` is still read as the `main` snapshot

## HDRI Transcoding Requirement
HDRI import uses `toktx` for KTX2 generation. Ensure `toktx` is installed and on your `PATH`.
For runtime KTX2 decode, place basis transcoder files in `public/basis/` (e.g. `basis_transcoder.js`, `basis_transcoder.wasm`).

## Notes
- Web mode (`public/sessions/...`) is read-only and intended for future Vercel deploys.
- Gaussian splat support uses the Spark/WebGL path.
- Plugin sample package: `plugins/example-wave-plugin`.
- Plugin template package: `plugins/template-artwork-actor-plugin`.
- Local external plugin workspace (gitignored): `plugins-local/`.
- Plugin handshake contract and loader expectations: `docs/plugin-handshake.md`.
- Desktop mode auto-discovers local plugins from:
  - `plugins-local/*/dist/index.js`
  - `plugins/*/dist/index.js`
- Top toolbar `Plugins` button opens plugin status dialog (installed plugins + refresh).
- Load built plugin modules from console, for example:
  - `plugin.load("file:///C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js")`
  - In Electron+Vite dev (`http://localhost:5180`), `file:///...` plugin paths are normalized to Vite `@fs` imports by the plugin loader.
  - If a plugin does not appear in the `+` menu, check the Plugins dialog and status message for the first load failure reason.

## Gaussian Asset Compatibility
- The removed native Gaussian Splat system is no longer supported.
- Legacy projects that still reference native `gaussian-splat` actors or `splatbin-v1` assets now fail load with an explicit compatibility error.
- Legacy single-manifest session folders are treated as projects whose `session.json` is the `main` snapshot.

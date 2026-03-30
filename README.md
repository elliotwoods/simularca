# Simularca

Desktop-first simulation environment for kinetic art pre-visualization.

![Simularca screenshot](./screenshot.png)

## Stack
- Electron main process + Vite/React renderer + TypeScript
- `flexlayout-react` multi-panel workspace
- Three.js viewport with WebGPU and WebGL render paths
- Spark/WebGL Gaussian splat rendering path
- Zustand + Immer app state
- Local plugin discovery for built plugin packages

## What Exists Today
- Desktop mode is the primary mode. It runs through Electron and reads/writes project data in `savedata/`.
- Browser mode exists for read-only sessions served from `public/sessions/`.
- There is no packaged installer workflow in this repository yet. No `electron-builder`, DMG, EXE, or app bundle pipeline is configured.

## Requirements
- Node.js and npm
- Electron dependencies installed through `npm install`
- `toktx` on `PATH` for HDRI to KTX2 transcoding
- `ffmpeg` on `PATH` for video export workflows
- basis transcoder runtime files in `public/basis/` for KTX2 decode, for example `basis_transcoder.js` and `basis_transcoder.wasm`

## Install
```bash
npm install
```

## Run

### Full desktop dev workflow
```bash
npm run dev
```

This starts three processes in parallel:
- plugin watchers via `scripts/plugins.mjs watch`
- the Vite dev server at `http://localhost:5180`
- Electron after the Vite server is reachable

### Web-only dev
```bash
npm run dev:web
```

This runs the renderer in the browser at `http://localhost:5180`. This mode is useful for renderer/UI work, but it is read-only compared with Electron desktop mode.

### Electron-only dev
```bash
npm run dev:electron
```

Use this when the Vite dev server is already running. The script waits for `http://localhost:5180`, compiles the Electron TypeScript entrypoints, then launches Electron against the dev server.

### Plugin watch only
```bash
npm run dev:plugins
```

This watches plugin packages under `plugins/` and `plugins-local/` when they expose `dev`, `watch`, or `build` scripts.

### Reset dev cache
```bash
npm run dev:reset
```

This clears the Vite cache through the existing PowerShell-based helper script, then starts the normal desktop dev flow.

## Debugging And Diagnostics

### Electron devtools
In desktop dev mode, Electron opens detached DevTools automatically.

### Runtime logs
- Runtime log file: `logs/electron-runtime.log`
- Includes Electron startup/load failures, preload errors, renderer crashes, forwarded `window.error` / `unhandledrejection`, and higher-severity renderer console messages

### Helper commands
```bash
npm run dev:diag
npm run logs:show
npm run logs:tail
```

Notes:
- `dev:diag` runs the normal dev flow and tails the runtime log in parallel.
- `logs:show` and `logs:tail` are implemented with `powershell`, so they depend on PowerShell being available in your shell environment.
- If those helpers are unavailable on your machine, inspect `logs/electron-runtime.log` directly.

## Build

### Web build
```bash
npm run build
```

This:
- writes build metadata
- builds plugin packages
- runs the composite TypeScript project build
- emits the Vite production renderer into `dist/`
- refreshes the Electron compile output in `dist-electron/`

### Electron TypeScript build
```bash
npm run build:electron
```

Use this when you only want to recompile the Electron entrypoints into `dist-electron/` without rebuilding the renderer. It does not package or install the app.

### Local production-style Electron run
If you want to launch the built app locally from the repository checkout:

```bash
npm run build
npx electron ./dist-electron/electron/main.js
```

This is a local launch path only. The repository does not currently produce an installable desktop application artifact.

## Test And Quality Checks
```bash
npm run test
npm run test:watch
npm run test:plugins
npm run typecheck
npm run lint
```

## Project Data
- Desktop defaults: `savedata/defaults.json`
- Desktop projects: `savedata/<projectName>/`
- Snapshots: `savedata/<projectName>/snapshots/<snapshotName>.json`
- Imported assets: `savedata/<projectName>/assets/...`
- Window state: `savedata/window-state.json`
- Legacy compatibility: `savedata/<projectName>/session.json` is still read as the `main` snapshot

## Plugins
- Built local plugins are auto-discovered from:
  - `plugins/*/dist/index.js`
  - `plugins-local/*/dist/index.js`
- Reference plugin packages live in `plugins/`
- Recommended local external plugin workspace: `plugins-local/` (gitignored)
- Plugin-specific regression harnesses should live with their standalone plugin repos under `plugins-local/`
- Host/plugin contract notes: `docs/plugin-handshake.md`
- See `plugins/README.md` for the reference package layout

Example packages in this repository:
- `plugins/example-wave-plugin`
- `plugins/template-artwork-actor-plugin`
- `plugins/beam-crossover-plugin`
- `plugins/gaussian-splat-webgpu-plugin`

## Asset And Rendering Notes
- HDRI import depends on `toktx`
- Video export depends on `ffmpeg`
- Browser mode serves read-only session data from `public/sessions/`
- Legacy projects that still reference removed native `gaussian-splat` actors or `splatbin-v1` assets fail with an explicit compatibility error

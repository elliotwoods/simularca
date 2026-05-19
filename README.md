<div align="center">

<img src="./icon.png" alt="Simularca" width="120" />

# Simularca

### Pre-visualize kinetic art before you build it.

Build a virtual version of an installation, dial in parameters, capture renders,
and communicate the idea — all before a single motor turns.

[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](#license)
![Platform](https://img.shields.io/badge/platform-desktop%20(Electron)-blueviolet)
![Renderer](https://img.shields.io/badge/render-WebGPU%20%2B%20WebGL-ff6f61)
![Three.js](https://img.shields.io/badge/three.js-0.173-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6)

<img src="./screenshot.png" alt="Simularca screenshot" width="860" />

</div>

---

## Why Simularca

| | |
| --- | --- |
| **Real-time 3D viewport** | WebGPU *and* WebGL render paths, PBR materials, environment probes, ACES tone mapping, and post-processing (bloom, vignette, grain, chromatic aberration). |
| **Gaussian splat rendering** | Drop a captured splat of the real venue into your scene and animate against it. Native Spark WebGL path plus a custom WebGPU path with GPU sorting for high splat counts. |
| **Hardware in the loop** | MIDI in/out and serial device support, including built-in integration for the Melbourne Instruments **Roto Control** surface. Map controllers directly to actor parameters. |
| **Plugin-based actors** | Every artwork is a plugin — ship a custom actor type with its own runtime, shaders, parameters, and inspector UI without forking the host. Reference plugin and template included. |
| **Project + snapshot workflow** | Projects are folders you store anywhere (including cloud-synced), identified by a `.simularca` pointer with a stable UUID. Snapshots are named variants — branch a lighting test or choreography pass without losing the last good state. |
| **Camera paths & curves** | Spline-based camera animation with keyframes and curve/actor targeting, plus a curve editor for path-driven motion. |
| **Multi-panel workspace** | Drag-and-dock layout (viewport, scene tree, inspector, console, profiler, plugin views) you can rearrange per project. |
| **Imports** | DXF (CAD layers, plane/unit selection), Collada `.dae` meshes, PLY and `.splatbin` Gaussian splats, HDRI environments transcoded to KTX2. |
| **Video export** | Export via `ffmpeg`, with frame-pacing for deterministic captures. |
| **Color & precision** | Pick your working color space (linear, sRGB, iPhone SDR, Apple Log) and float32 / float16 / uint8 render-target precision. |
| **Profiling** | Per-actor CPU/GPU timing including WebGPU timestamp queries, surfaced live in a profiler panel. |

## Status

Simularca is desktop-first and runs through Electron. The repository builds and runs from source — there is no packaged installer (no `.exe` / `.dmg`) yet. Browser mode exists but is read-only and intended for sharing sessions.

## Quick start

### Prerequisites

- **Node.js** (LTS) and **npm**
- **`toktx`** on `PATH` — for HDRI → KTX2 transcoding ([KTX-Software releases](https://github.com/KhronosGroup/KTX-Software/releases))
- **`ffmpeg`** on `PATH` — for video export
- **basis transcoder** runtime files in `public/basis/` (`basis_transcoder.js` and `basis_transcoder.wasm`) for KTX2 decode at runtime

### Get it running

```bash
git clone https://github.com/elliotwoods/simularca.git
cd simularca
npm install
npm run dev
```

`npm run dev` starts the plugin watcher, the Vite dev server on `http://localhost:5180`, and Electron together. The app window opens once the dev server is up.

On first launch the welcome screen lets you create a new project or open an existing one. Projects are folders you choose (default location: `~/Documents/Simularca Projects/<ProjectName>/`); each contains a `<ProjectName>.simularca` pointer file plus `snapshots/` and `assets/`. App-internal state (recents list, default project, window layout) lives in your OS user-data folder:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%/Simularca/` |
| macOS | `~/Library/Application Support/Simularca/` |
| Linux | `~/.config/Simularca/` |

If you previously had projects under `savedata/` next to the repo, the app shows a migration dialog on startup so you can pick a destination for each one.

### Other run modes

| Command | What it does |
| --- | --- |
| `npm run dev` | Full desktop dev: plugin watcher + Vite + Electron |
| `npm run dev:web` | Renderer only, in the browser at `http://localhost:5180` (read-only) |
| `npm run dev:electron` | Electron against an already-running Vite server |
| `npm run dev:plugins` | Watch and rebuild plugin packages only |
| `npm run dev:reset` | Clear Vite cache, then `dev` |

### Build

```bash
npm run build       # plugins + TS + Vite renderer + Electron entrypoints
```

To launch the built app locally from the checkout:

```bash
npx electron ./dist-electron/electron/main.js
```

## Plugins

Built-in reference plugins live under `plugins/`:

- `gaussian-splat-webgpu-plugin` — WebGPU Gaussian splat actor with GPU sorting
- `dxf-drawing-plugin` — DXF-driven scene drawing
- `roto-control-plugin` — Melbourne Instruments Roto Control hardware bridge
- `example-wave-plugin`, `template-artwork-actor-plugin` — starting points for your own artwork actors

Build outputs are auto-discovered from `plugins/*/dist/index.js` and `plugins-external/*/dist/index.js`. See `plugins/README.md` for the package layout and `docs/plugin-handshake.md` for the host/plugin contract.

## For developers

- Tests: `npm run test` — plugin subset: `npm run test:plugins`
- Type-check: `npm run typecheck` — Lint: `npm run lint`
- Runtime log: `logs/electron-runtime.log` (`npm run logs:tail` to follow)
- Live debug bridge: `docs/live-debug-bridge.md`
- Project data layout, snapshots, and asset paths: see `CLAUDE.md` and `docs/`

## License

MIT

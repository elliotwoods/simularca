# Simularca

**A desktop simulation environment for pre-visualizing kinetic art.**

Build a virtual version of an art installation, test parameters, create renders, ideate and communicate with others.

![Simularca screenshot](./screenshot.png)

## Why Simularca

- **Real-time 3D viewport** with both WebGPU and WebGL render paths, PBR materials, environment probes, ACES tone mapping, and post-processing (bloom, vignette, grain, chromatic aberration).
- **Gaussian splat rendering** — drop a captured splat of the real venue into your scene and animate against it. Native Spark WebGL path plus a custom WebGPU path with GPU sorting for high splat counts.
- **Hardware in the loop** — MIDI input/output and serial device support, including built-in integration for the Melbourne Instruments **Roto Control** surface. Map controllers directly to actor parameters.
- **Plugin-based actors** — every artwork is a plugin. Ship a custom actor type with its own runtime, shaders, parameters, and inspector UI without forking the host. A reference plugin and template are included.
- **Project + snapshot workflow** — projects are folders you store anywhere on disk (including cloud-synced folders), identified by a `.simularca` pointer file with a stable UUID; snapshots are named variants inside a project, so you can branch a lighting test or a choreography pass without losing the last good state.
- **Camera paths and curves** — spline-based camera animation with keyframes and curve/actor targeting, plus a curve editor for path-driven motion.
- **Multi-panel workspace** — drag-and-dock layout (viewport, scene tree, inspector, console, profiler, plugin views) you can rearrange per project.
- **Imports** — DXF (CAD layers, plane and unit selection), Collada `.dae` meshes, PLY and `.splatbin` Gaussian splats, HDRI environments transcoded to KTX2.
- **Video export** via `ffmpeg`, with a frame-pacing option for deterministic captures.
- **Color and precision** — pick your working color space (linear, sRGB, iPhone SDR, Apple Log) and float32 / float16 / uint8 render-target precision.
- **Profiling** — per-actor CPU/GPU timing including WebGPU timestamp queries, surfaced live in a profiler panel.

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

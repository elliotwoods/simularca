# Simularca Spec

## 1. Purpose
Build a pre-visualization simulation environment for kinetic artworks with a large interactive 3D viewport and fast local iteration.

## 2. Runtime and Deployment
- Runtime: `Electron + Vite + React + TypeScript`.
- Local desktop mode: read/write project filesystem.
- Web deploy mode (future Vercel): read-only, fixed bundled project.
- No Next.js required.

## 3. Core Tech Stack
- 3D: `Three.js` with `WebGPU` renderer for the main scene.
- Splat support: native in-scene Gaussian splat pipeline integrated with main WebGPU scene.
- Layout: `GoldenLayout` dockable/resizable panes.
- Inspector widgets: custom React widgets (schema-driven).
- Icons: Font Awesome, icon-first with tooltips.

## 4. Visual Direction
- Dark technical aesthetic.
- Sharp orthogonal lines and high clarity.
- Use monospace for data-heavy and technical controls.

## 5. Core Concepts
- `Scene`: top-level graph root, may contain global scene components.
- `Actor`: scene object with transform and optional child actors/components.
- `Component`: subsystem attached to scene or actor.
- `Parameter`: user-editable typed value driven by schema.
- `Plugin`: external extension package that can register actor/component types.

## 6. Data Contracts

### 6.1 Stable IDs
- Scene graph entities use stable UUID-like IDs for save/load and cross-reference.

### 6.2 Transform Model
- Actors use TRS (`position`, `rotation`, `scale`) with parent-child hierarchy.

### 6.3 Project Snapshot Manifest
- JSON primary format with `schemaVersion`.
- Includes:
  - scene graph (actors/components/params)
  - camera state and bookmarks
  - simulation time state
  - asset references

### 6.4 Project Filesystem
- Default pointer: `savedata/defaults.json`.
- Snapshot data: `savedata/<projectName>/snapshots/<snapshotName>.json`.
- Project assets: `savedata/<projectName>/assets/...`.
- Paths in snapshot data are relative to project directory for portability.
- Legacy compatibility: `savedata/<projectName>/session.json` is treated as snapshot `main`.

## 7. UI Layout
- Top panel:
  - project and snapshot management (load/save/save snapshot as/set default)
  - camera controls (preset views + bookmarks)
  - simulation time controls (play/pause/step/speed presets)
  - edit controls (undo/redo)
- Left panel:
  - scene graph (actors/components)
  - drag-drop reparent and reorder
  - scene statistics
- Center panel:
  - 3D viewport
  - transform gizmo integration path
  - import controls for HDRI and PLY in desktop mode
- Right panel:
  - schema-driven inspector
  - selection details and status

## 8. Interaction Model
- Selection:
  - actor or component selection
  - single + multi-selection supported
  - inspector supports common editable fields for group selection
- Graph operations:
  - create/delete/rename/reparent/reorder actors
  - drag-drop for reparent/reorder
- Undo/redo:
  - command history for scene and parameter edits

## 9. Simulation Controls
- Fixed timestep simulation at 60 Hz.
- Speed presets: `1/8x`, `1/4x`, `1/2x`, `1x`, `2x`, `4x`.
- Step increments one fixed frame at current speed.

## 10. Camera
- Presets: perspective, isometric (interactive orthographic), top, left, front, back.
- Default pose and named bookmarks stored per project snapshot.

## 11. Actor Types (Phase 1)
- `Empty` actor (grouping/transform parent).
- `Environment` actor:
  - local import
  - HDRI preprocessing to KTX2 pipeline
- `Gaussian Splat` actor:
  - `.ply` import
  - copy into project assets
  - Spark/WebGL runtime path
- `Mesh` actor:
  - local import (`.glb`, `.gltf`, `.fbx`, `.dae`, `.obj`)
  - copy into project assets
  - runtime loading via format-specific Three.js loaders
- `Plugin` actor:
  - formal API registration with stub runtime in phase 1.

## 12. Asset Pipelines
- Imported files are copied into managed project asset folders.
- Deleting actors/assets removes managed references/files.
- Environment import:
  - popup/options
  - transcode to KTX2 (`toktx` toolchain)
- Gaussian import:
  - `.ply` copy and runtime loading path
- Mesh import:
  - `.glb/.gltf/.fbx/.dae/.obj` copy and runtime loading path

## 13. Hot Reload Requirements
- Avoid full refresh for most renderer-side code changes.
- Hot-reload targets:
  - actor descriptors/runtime logic
  - component descriptors/runtime logic
  - inspector schema/UI
  - major renderer-side systems
- Preserve on hot update:
  - current scene/project snapshot state
  - camera
  - selection
  - undo/redo history
- Fallback:
  - if incompatible change is detected, rebuild affected runtime instances only.
- Known restart-required cases:
  - Electron main process changes
  - preload bridge contract changes

## 16. Plugin Handshake Contract
- External plugin modules must export handshake object via default or named `handshake` export.
- Contract includes:
  - manifest (`id`, `name`, `version`, handshake/api compatibility range)
  - `createPlugin()` returning actor/component descriptors
- Host validates compatibility and registers descriptors.
- Reference template:
  - `plugins/example-wave-plugin`
  - docs: `docs/plugin-handshake.md`

## 14. Keyboard Shortcuts
- `Space`: play/pause
- `Delete`: delete selection
- `Ctrl/Cmd + S`: save project
- `Ctrl/Cmd + Shift + S`: save snapshot as
- `Ctrl/Cmd + Z`: undo
- `Ctrl/Cmd + Shift + Z`: redo
- `?`: toggle keyboard map popup

## 15. Quality and Tooling
- TypeScript strict mode.
- Unit tests for core logic and future failure-prone paths.
- CI pipeline: lint + typecheck + unit tests.

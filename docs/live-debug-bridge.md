# Live Debug Bridge

## Purpose
The live debug bridge exposes a running local Electron dev session over a localhost JSON API so coding agents can inspect and execute code against the live app without manual DevTools interaction.

This is a development-only feature. It does not run in packaged builds.

## How It Works
- Electron main starts a localhost HTTP server on `127.0.0.1` during dev sessions.
- A per-launch bearer token is generated and written to `logs/codex-debug-session.json`.
- The renderer installs `window.__SIMULARCA_DEBUG__` during app startup in dev Electron mode.
- The bridge exposes both renderer and main-process execution paths:
  - renderer console mode reuses the existing Simularca console runtime
  - renderer eval mode exposes richer live state
  - main eval mode exposes Electron objects such as `BrowserWindow` and `webContents`

## Manifest
Manifest file: `logs/codex-debug-session.json`

Example fields:
- `pid`
- `startedAtIso`
- `port`
- `token`
- `baseUrl`
- `windowIds`
- `build.appVersion`
- `build.buildKind`
- `build.electronVersion`
- `build.nodeVersion`

If this file is missing, the app is not currently exposing a live debug session.

## CLI
Preferred entrypoint:

```bash
node scripts/debug-session.mjs health
node scripts/debug-session.mjs windows
node scripts/debug-session.mjs logs 200
node scripts/debug-session.mjs renderer --console "scene.stats()"
node scripts/debug-session.mjs renderer --eval "document.pointerLockElement"
node scripts/debug-session.mjs main "BrowserWindow.getAllWindows().map((w) => w.id)"
```

NPM alias:

```bash
npm run debug:session -- renderer --console "scene.stats()"
```

## HTTP API
All requests require:

```text
Authorization: Bearer <token from manifest>
```

Routes:
- `GET /health`
- `GET /windows`
- `GET /logs/runtime?tail=200`
- `POST /renderer/execute`
- `POST /main/execute`

Renderer execute request:

```json
{
  "source": "scene.stats()",
  "mode": "console",
  "windowId": 1
}
```

Main execute request:

```json
{
  "source": "BrowserWindow.getFocusedWindow()?.id"
}
```

## Renderer Modes
### Console
Use renderer console mode for normal app/runtime commands:
- `scene.stats()`
- `scene.profile.state()`
- `scene.profile.latestSummary()`
- `scene.profile.latestRaw()`
- `actor.list()`
- `camera.state()`
- `project.status()`

This path preserves the same execution semantics and result shape as the in-app console panel.

Profiler examples:

```bash
node scripts/debug-session.mjs renderer --console "scene.profile.state()"
node scripts/debug-session.mjs renderer --console "scene.profile.latestSummary()"
node scripts/debug-session.mjs renderer --console "scene.profile.latestRaw()"
```

- `scene.profile.state()` returns the live capture state and progress.
- `scene.profile.latestSummary()` returns compact LLM-friendly JSON summaries.
- `scene.profile.latestRaw()` returns the full hierarchical result tree for deeper analysis.

### Eval
Use renderer eval mode for direct access to live renderer state. Available bindings include:
- `kernel`
- `store`
- `projectService`
- `descriptorRegistry`
- `hotReloadManager`
- `pluginApi`
- `clock`
- `document`
- `globalWindow`
- `buildInfo`

Examples:

```bash
node scripts/debug-session.mjs renderer --eval "document.pointerLockElement"
node scripts/debug-session.mjs renderer --eval "store.getState().state.selection"
node scripts/debug-session.mjs renderer --eval "kernel.store.getState().state.stats"
```

## Main-Process Eval
Main-process eval exposes:
- `app`
- `BrowserWindow`
- `webContents`
- `ipcMain`
- `dialog`
- `process`
- `path`
- `fs`
- `mainWindow`
- `allWindows`
- `focusedWindow()`
- `runtimeLogTail()`

Examples:

```bash
node scripts/debug-session.mjs main "focusedWindow()?.isFocused()"
node scripts/debug-session.mjs main "await runtimeLogTail(50)"
```

## Security Model
- Listens only on `127.0.0.1`
- Rejects non-loopback requests
- Uses a random per-launch bearer token
- Writes the manifest only inside the repo `logs/` directory

This is intended for local development only.

## Failure Modes
- Missing manifest: the dev session is not running.
- `renderer bridge unavailable or reloading`: the renderer is still booting or Vite HMR is remounting the app.
- HTTP 401: the token is stale; re-read the manifest.
- No window available: Electron has no live renderer window yet.

## Recommended Agent Workflow
1. Read `logs/codex-debug-session.json`.
2. Run `node scripts/debug-session.mjs health`.
3. Start with `renderer --console` if the issue looks app-level.
4. Switch to `renderer --eval` for DOM/input/viewport details.
5. Use `main` for Electron shell, focus, fullscreen, or window lifecycle bugs.
6. Tail runtime logs if an exception path is suspected.

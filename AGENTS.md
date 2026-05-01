# Agent Notes

## Live Debug Bridge
- When debugging a running local Electron dev session, prefer the live debug bridge over asking the user to paste DevTools snippets.
- This bridge is dev-only. It is available only while Simularca is running via the Electron dev flow.

## Discovery Flow
1. Check `logs/codex-debug-session.json`.
2. If it exists, confirm the session is alive with `node scripts/debug-session.mjs health`.
3. Use the CLI wrapper instead of hand-building HTTP requests unless you need a route the CLI does not cover.

## Commands
- Renderer console commands:
  - `node scripts/debug-session.mjs renderer --console "scene.stats()"`
  - Use this for the normal app console/runtime APIs such as `scene`, `actor`, `camera`, `project`, and `window`.
- Renderer eval commands:
  - `node scripts/debug-session.mjs renderer --eval "document.pointerLockElement"`
  - Use this for live DOM, input, viewport, canvas, and renderer state that is not exposed through the app console API.
- Main-process commands:
  - `node scripts/debug-session.mjs main "BrowserWindow.getAllWindows().map((w) => w.id)"`
  - Use this for Electron window state, `webContents`, IPC, dialogs, and runtime log inspection.
- Runtime logs:
  - `node scripts/debug-session.mjs logs 200`

## When To Use Which Mode
- Use `renderer --console` first for app-level inspection because it reuses Simularca's structured console runtime.
- Use `renderer --eval` when you need direct access to `kernel`, `store`, `document`, `window`, or live event/canvas state.
- Use `main` when the bug may be in Electron shell behavior, window focus/fullscreen state, preload wiring, or `webContents`.

## Failure Handling
- If the manifest is missing or stale, treat that as "session not running" and fall back to normal static debugging.
- If renderer execution returns `renderer bridge unavailable or reloading`, wait for the app to finish hot reloading and try again.
- If auth fails, re-read the manifest because the token is per-launch.
- Do not assume this bridge exists in production builds or browser-only sessions.

## Reference
- See `docs/live-debug-bridge.md` for the full protocol, manifest shape, and examples.

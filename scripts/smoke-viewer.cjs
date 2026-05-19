// Headless smoke test: launch Electron, point a hidden BrowserWindow at the
// vite-served viewer.html with the staged dev-publish payload, capture
// console + page errors, exit when the viewer reports ready (or on timeout).
//
// Run with: npx electron scripts/smoke-viewer.cjs
// Vite dev server must already be listening on http://localhost:5180.

const { app, BrowserWindow } = require("electron");

const VIEWER_URL =
  "http://localhost:5180/viewer.html?manifest=/dev-publish/payload.json";
const TIMEOUT_MS = 25000;
const READY_MARKER = "Viewer ready.";

let resolved = false;
function done(code, reason) {
  if (resolved) return;
  resolved = true;
  console.log(`[smoke] DONE: ${reason}`);
  setTimeout(() => process.exit(code), 50);
}

app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
app.commandLine.appendSwitch("enable-unsafe-webgpu");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  win.webContents.on("console-message", (_event, level, message) => {
    const levels = ["debug", "info", "warning", "error"];
    const tag = levels[level] ?? "log";
    console.log(`[viewer:${tag}] ${message}`);
    if (typeof message === "string" && message.includes(READY_MARKER)) {
      done(0, "viewer reported ready");
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[smoke] did-fail-load ${String(errorCode)} ${errorDescription} url=${validatedURL}`);
    done(2, "did-fail-load");
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[smoke] render-process-gone reason=${details.reason} exitCode=${String(details.exitCode)}`);
    done(3, "render-process-gone");
  });

  win.webContents.on("did-finish-load", () => {
    console.log("[smoke] did-finish-load");
  });

  setTimeout(() => done(4, "timeout"), TIMEOUT_MS);

  try {
    await win.loadURL(VIEWER_URL);
  } catch (error) {
    console.error(`[smoke] loadURL threw: ${error instanceof Error ? error.message : String(error)}`);
    done(5, "loadURL threw");
  }
});

app.on("window-all-closed", () => {
  done(0, "windows closed");
});

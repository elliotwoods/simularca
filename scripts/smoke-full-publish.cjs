// End-to-end publish smoke test. Loads the user's saved publish settings,
// decrypts the R2 secret + Vercel token, runs the full publishService
// pipeline against the SSG Stadium snapshot, then headless-loads the
// resulting viewer URL and confirms "Viewer ready" fires.
//
// Usage:
//   npx electron scripts/smoke-full-publish.cjs
//
// Optional env:
//   SIMULARCA_SMOKE_SNAPSHOT     snapshot name to publish (default: from defaults.json)
//   SIMULARCA_SMOKE_PUBLISH_ID   reuse an existing publish id (otherwise generated)

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.setName("Simularca");

let exitCode = 0;
function shutdown(code) {
  exitCode = code;
  setTimeout(() => process.exit(exitCode), 100);
}

setTimeout(() => {
  console.error("[smoke] HARD TIMEOUT");
  shutdown(99);
}, 20 * 60 * 1000);

app.whenReady().then(async () => {
  try {
    // ----------------------------------------------------------------
    // 1. Load settings + decrypt secrets
    // ----------------------------------------------------------------
    const userData = app.getPath("userData");
    const settingsPath = path.join(userData, "publish-settings.json");
    const defaultsPath = path.join(userData, "defaults.json");
    if (!fs.existsSync(settingsPath)) throw new Error(`No ${settingsPath}`);
    if (!fs.existsSync(defaultsPath)) throw new Error(`No ${defaultsPath}`);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
    const target = settings.targets?.[0];
    if (!target) throw new Error("No publish targets configured.");
    if (!target.r2?.secretAccessKey) {
      throw new Error("Target has no plaintext R2 secret. Re-save via the credentials modal.");
    }

    const projectPath = defaults.path;
    const snapshotName = process.env.SIMULARCA_SMOKE_SNAPSHOT || defaults.lastSnapshotName || "main";
    const projectFolder = path.dirname(projectPath);
    const projectUuid = JSON.parse(fs.readFileSync(projectPath, "utf8")).uuid;
    const projectName = path.basename(projectFolder);

    console.log(`[smoke] target=${target.label} bucket=${target.r2.bucket} bucketBaseUrl=${target.bucketBaseUrl}`);
    console.log(`[smoke] project=${projectName} uuid=${projectUuid} snapshot=${snapshotName}`);

    // ----------------------------------------------------------------
    // 2. Run the publish pipeline
    // ----------------------------------------------------------------
    const repoRoot = path.resolve(__dirname, "..");
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".simularca-build-info.json"), "utf8")
    );
    const requiredViewerSha = buildInfo.commitShortSha;
    const appVersion = buildInfo.version;

    const publishServicePath = path.join(repoRoot, "dist-electron", "electron", "publishService.js");
    const { startPublish, resolvePluginEntry } = await import(
      `file:///${publishServicePath.replaceAll("\\", "/")}`
    );

    // Mirror main.ts's discoverInstalledPlugins().
    const discoveredPlugins = [];
    const seenPluginIds = new Set();
    for (const root of [path.join(repoRoot, "plugins-external"), path.join(repoRoot, "plugins")]) {
      if (!fs.existsSync(root)) continue;
      for (const entryName of fs.readdirSync(root)) {
        const pluginRoot = path.join(root, entryName);
        if (!fs.statSync(pluginRoot).isDirectory()) continue;
        const pkgPath = path.join(pluginRoot, "package.json");
        if (!fs.existsSync(pkgPath)) continue;
        let pkg;
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
        const id = pkg.name || entryName;
        if (seenPluginIds.has(id)) continue;
        let entryPath;
        try { entryPath = resolvePluginEntry(pluginRoot); } catch { continue; }
        if (!fs.existsSync(entryPath)) {
          console.log(`[smoke] plugin ${id}: not built; skipping`);
          continue;
        }
        seenPluginIds.add(id);
        discoveredPlugins.push({ id, entryPath, version: pkg.version || "0.0.0" });
      }
    }
    console.log(`[smoke] discovered ${discoveredPlugins.length} plugin(s):`, discoveredPlugins.map(p => p.id).join(", "));

    const viewerConfig = {
      configVersion: 1,
      panels: { sceneTree: true, inspector: true, console: true, snapshotPicker: true },
      interactions: {
        transformGizmo: false,
        axisWidget: true,
        viewPresets: true,
        postProcessing: true,
        orbitPanZoom: true
      },
      branding: {}
    };

    console.log("[smoke] Starting publish…");
    const lastEventByPhase = new Map();
    const result = await startPublish({
      jobId: "smoke-" + Date.now(),
      publishId: process.env.SIMULARCA_SMOKE_PUBLISH_ID || undefined,
      projectFolder,
      projectUuid,
      projectName,
      snapshotNames: [snapshotName],
      title: `${projectName} (smoke)`,
      viewerConfig,
      target,
      requiredViewerSha,
      appVersion,
      viewerExternalsPath: path.join(repoRoot, "viewer-externals.json"),
      discoveredPlugins,
      onProgress: (event) => {
        // Throttle: log first + last event per phase + every fifth progress tick.
        const prev = lastEventByPhase.get(event.phase) ?? 0;
        const now = Date.now();
        if (now - prev < 500 && event.phase !== "done" && event.phase !== "error") return;
        lastEventByPhase.set(event.phase, now);
        const parts = [`[${event.phase}]`];
        if (event.current !== undefined && event.total !== undefined) {
          parts.push(`${event.current}/${event.total}`);
        }
        if (event.currentItem) parts.push(event.currentItem);
        if (event.message) parts.push(event.message);
        if (event.viewerUrl) parts.push(event.viewerUrl);
        if (event.error) parts.push(`ERR: ${event.error}`);
        console.log(parts.join(" "));
      }
    });

    console.log(`[smoke] ✓ Published. publishId=${result.publishId} manifestSha=${result.manifestSha}`);
    console.log(`[smoke] viewerUrl=${result.viewerUrl}`);

    // Mirror what the IPC handler does — persist the publish into
    // publish-settings.json so the sidebar would see it. The IPC handler
    // also handles encryption etc., but for the smoke we just write the
    // structured entry directly.
    {
      const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const list = settingsAfter.publishesByProjectUuid[projectUuid] ?? [];
      const filtered = list.filter((entry) => entry.publishId !== result.publishId);
      const entry = {
        publishId: result.publishId,
        title: `${projectName} (smoke)`,
        lastPublishedAtIso: new Date().toISOString(),
        targetId: target.id,
        viewerUrl: result.viewerUrl,
        requiredViewerSha: result.requiredViewerSha,
        referencedBlobs: result.referencedBlobs ?? []
      };
      settingsAfter.publishesByProjectUuid[projectUuid] = [entry, ...filtered];
      fs.writeFileSync(settingsPath, JSON.stringify(settingsAfter, null, 2), "utf8");
      const total = entry.referencedBlobs.reduce((a, b) => a + b.byteSize, 0);
      console.log(`[smoke] Persisted entry with ${entry.referencedBlobs.length} blobs (${(total / 1024 / 1024).toFixed(1)} MB)`);
    }

    // ----------------------------------------------------------------
    // 3. Headless-load the viewer URL and watch for "Viewer ready"
    // ----------------------------------------------------------------
    console.log("[smoke] Loading viewer URL in hidden BrowserWindow…");
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { contextIsolation: true, sandbox: true }
    });

    let resolvedLoad;
    const loadPromise = new Promise((resolve) => {
      resolvedLoad = resolve;
    });

    const captured = [];
    win.webContents.on("console-message", (_e, level, message) => {
      const levels = ["debug", "info", "warning", "error"];
      const tag = levels[level] ?? "log";
      captured.push({ tag, message });
      // Filter: surface only errors/warnings + beam/cross-section/curve/target hits.
      const isInteresting =
        tag === "error" ||
        tag === "warning" ||
        /beam|cross[\s-]?section|curve|target|descriptor|plugin/i.test(String(message));
      if (isInteresting) {
        console.log(`[viewer:${tag}] ${message}`);
      }
      if (typeof message === "string" && message.includes("FATAL")) {
        resolvedLoad({ kind: "fatal", message });
      }
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      resolvedLoad({ kind: "load-fail", message: `${code} ${desc} ${url}` });
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      resolvedLoad({
        kind: "render-gone",
        message: `${details.reason} ${details.exitCode}`
      });
    });

    // Sit on the page long enough for a 200 MB FBX to download.
    setTimeout(() => resolvedLoad({ kind: "done-waiting" }), 180_000);

    try {
      await win.loadURL(result.viewerUrl);
    } catch (error) {
      resolvedLoad({
        kind: "load-error",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const outcome = await loadPromise;
    console.log(`[smoke] viewer outcome: ${outcome.kind} — ${outcome.message ?? ""}`);
    if (outcome.kind === "fatal") {
      throw new Error(`Viewer fatal: ${outcome.message}`);
    }
    // Summarise captured console for plugin diagnostics.
    const pluginLogs = captured.filter((c) => /plugin|descriptor|register|three/i.test(c.message));
    console.log(`[smoke] captured ${captured.length} console line(s); ${pluginLogs.length} plugin-related.`);
    console.log(`[smoke] ✓ End-to-end publish + viewer load reached.`);
  } catch (error) {
    console.error("[smoke] FAILED:", error?.stack ?? error?.message ?? String(error));
    exitCode = 1;
  } finally {
    shutdown(exitCode);
  }
});

// Smoke test for the Vercel deploy path. Loads the user's saved publish
// settings, decrypts the Vercel token via Electron's safeStorage, then runs
// the full deploy pipeline (build + ensureProject + createDeployment).
//
// Usage:
//   npx electron scripts/smoke-vercel-deploy.cjs
//
// Exits 0 on a working deploy (prints the resulting URL), nonzero on failure.

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// MUST set the app name BEFORE the first app.getPath() call or userData
// resolves to AppData/Roaming/Electron instead of AppData/Roaming/Simularca.
app.setName("Simularca");

const TIMEOUT_MS = 10 * 60 * 1000;

let resolveDone;
let exitCode = 0;
const done = new Promise((resolve) => {
  resolveDone = resolve;
});

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  try {
    const settingsPath = path.join(app.getPath("userData"), "publish-settings.json");
    if (!fs.existsSync(settingsPath)) {
      throw new Error(`No publish-settings.json at ${settingsPath}.`);
    }
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const viewer = settings.viewerDeployment;
    if (!viewer?.vercelTokenEncryptedBase64) {
      throw new Error("No Vercel token configured in publish-settings.json.");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is unavailable; cannot decrypt Vercel token.");
    }
    const token = safeStorage.decryptString(
      Buffer.from(viewer.vercelTokenEncryptedBase64, "base64")
    );
    const projectName = viewer.vercelProjectName || "simularca-viewer";
    const teamId = viewer.vercelTeamId;
    console.log(`[smoke] token len=${token.length} project=${projectName} team=${teamId ?? "(personal)"}`);

    const repoRoot = path.resolve(__dirname, "..");
    // 1. Build viewer bundle.
    console.log("[smoke] Building viewer bundle…");
    fs.rmSync(path.join(repoRoot, "dist"), { recursive: true, force: true });
    if (!process.env.SIMULARCA_SMOKE_SKIP_BUILD_INFO) {
      await runChild(process.execPath, [path.join(repoRoot, "scripts", "write-build-info.mjs"), "build"], {
        cwd: repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
    }
    await runChild(process.execPath, [path.join(repoRoot, "scripts", "build-viewer.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    fs.copyFileSync(
      path.join(repoRoot, "vercel.json"),
      path.join(repoRoot, "dist", "vercel.json")
    );

    // 2. Import compiled vercelDeploy.
    const deployModulePath = path.join(repoRoot, "dist-electron", "electron", "vercelDeploy.js");
    const deployModule = await import(`file:///${deployModulePath.replaceAll("\\", "/")}`);
    const { ensureVercelProject, deployViewer } = deployModule;

    // 3. Ensure project exists.
    console.log("[smoke] Ensuring Vercel project…");
    const project = await ensureVercelProject({ token, teamId, name: projectName });
    console.log(`[smoke] project id=${project.projectId} name=${project.name} created=${project.created}`);

    // 4. Run deploy.
    console.log("[smoke] Starting deploy…");
    const result = await deployViewer({
      token,
      teamId,
      projectName: project.name,
      distDir: path.join(repoRoot, "dist"),
      sha: JSON.parse(fs.readFileSync(path.join(repoRoot, ".simularca-build-info.json"), "utf8")).commitShortSha,
      onProgress: (event) => {
        const parts = [`[deploy:${event.phase}]`];
        if (event.message) parts.push(event.message);
        if (event.uploadedFiles !== undefined && event.totalFiles !== undefined) {
          parts.push(`(${event.uploadedFiles}/${event.totalFiles} files)`);
        }
        if (event.url) parts.push(event.url);
        if (event.error) parts.push(`ERR: ${event.error}`);
        console.log(parts.join(" "));
      }
    });
    console.log(`[smoke] ✓ Deployed. URL: https://${result.url}`);
    if (result.alias) console.log(`[smoke] Aliases: ${result.alias.join(", ")}`);
  } catch (error) {
    console.error("[smoke] FAILED:", error?.stack ?? error?.message ?? String(error));
    exitCode = 1;
  } finally {
    resolveDone();
  }
});

setTimeout(() => {
  console.error("[smoke] TIMED OUT");
  exitCode = 2;
  resolveDone();
}, TIMEOUT_MS);

done.then(() => {
  setTimeout(() => process.exit(exitCode), 100);
});

function runChild(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

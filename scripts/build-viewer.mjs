#!/usr/bin/env node
// Builds the published-snapshot viewer entry as a standalone, versioned
// bundle under `dist/v/<commitShortSha>/`. Each release is immutable; old
// `<sha>` paths stay live indefinitely on Vercel so previously-published
// snapshot URLs (which embed their required viewer sha) keep working.
//
// Asserts that no dev-only escape strings ("manifest=", "dev-publish") leak
// into the production bundle.
//
// CI invokes this in front of `vercel deploy`; failure halts the deploy.

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const BUILD_INFO_PATH = join(REPO_ROOT, ".simularca-build-info.json");
const VIEWER_HTML = join(REPO_ROOT, "viewer.html");

const FORBIDDEN_TOKENS = ["manifest="];

// Directories under `public/` that Vite copies into every build by default
// but which must NOT ship to the public viewer deployment. Each path is
// relative to the build output root (`outDir`).
const PRUNE_PATHS = ["dev-publish"];

function loadCommitShortSha() {
  try {
    const raw = readFileSync(BUILD_INFO_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.commitShortSha === "string" && parsed.commitShortSha.length > 0) {
      return parsed.commitShortSha;
    }
  } catch {
    // Fall through to default.
  }
  console.warn("[build-viewer] No .simularca-build-info.json — using 'dev' as the sha. Run scripts/write-build-info.mjs first to get a real sha.");
  return "dev";
}

function safeExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    if (!safeExists(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function assertNoLeaks(files) {
  const offenders = [];
  for (const path of files) {
    if (!path.endsWith(".js") && !path.endsWith(".html") && !path.endsWith(".css")) {
      continue;
    }
    const contents = readFileSync(path, "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      if (contents.includes(token)) {
        offenders.push({ path, token });
      }
    }
  }
  if (offenders.length > 0) {
    console.error("Dev-only strings leaked into the production viewer bundle:");
    for (const { path, token } of offenders) {
      console.error(`  ${path}: contains "${token}"`);
    }
    throw new Error("Viewer bundle leak assertion failed.");
  }
}

async function main() {
  const sha = loadCommitShortSha();
  const baseUrl = `/v/${sha}/`;
  const outDir = join("dist", "v", sha);

  console.log(`[build-viewer] sha=${sha}`);
  console.log(`[build-viewer] base=${baseUrl}`);
  console.log(`[build-viewer] outDir=${outDir}`);

  // Vite programmatic build, viewer-only. We intentionally override
  // `rollupOptions.input` so the editor entry is NOT built — the viewer
  // deployment is independent of Electron and must not ship editor code.
  await build({
    configFile: resolve(REPO_ROOT, "vite.config.ts"),
    root: REPO_ROOT,
    mode: "viewer-production",
    base: baseUrl,
    build: {
      outDir: resolve(REPO_ROOT, outDir),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: { viewer: VIEWER_HTML }
      }
    }
  });

  // Prune dev-only fixtures that Vite copied from public/.
  for (const relative of PRUNE_PATHS) {
    const target = resolve(REPO_ROOT, outDir, relative);
    if (safeExists(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`[build-viewer] Pruned dev-only path: ${relative}`);
    }
  }

  const allFiles = listFilesRecursive(resolve(REPO_ROOT, outDir));
  if (allFiles.length === 0) {
    throw new Error(`Viewer build produced no files at ${outDir}.`);
  }
  assertNoLeaks(allFiles);

  // Belt-and-braces: refuse the build if any of the pruned paths somehow
  // reappear (e.g. a future contributor adds a copy step that re-creates
  // them, or moves them under a different name).
  for (const relative of PRUNE_PATHS) {
    if (safeExists(resolve(REPO_ROOT, outDir, relative))) {
      throw new Error(
        `Dev-only path '${relative}' is still present in the build output after prune — refusing to ship.`
      );
    }
  }

  console.log(`[build-viewer] OK. Output: ${outDir} (${String(allFiles.length)} files).`);
  console.log(`[build-viewer] Deploy by serving dist/ on Vercel. Viewer entry: ${baseUrl}viewer.html`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

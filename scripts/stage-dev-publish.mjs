#!/usr/bin/env node
// One-shot staging script for the viewer smoke test (Phase 1.12 of the
// publish-to-web feature).
//
// Reads the active project from %APPDATA%/Simularca/defaults.json, copies the
// active snapshot + its referenced assets into public/dev-publish/, and
// writes the dev-escape payload at public/dev-publish/payload.json.
//
// Usage:
//   node scripts/stage-dev-publish.mjs
//
// After running, start `npm run dev:web` and open
// http://localhost:5180/viewer.html?manifest=/dev-publish/payload.json

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const APPDATA = process.env.APPDATA;
if (!APPDATA) {
  throw new Error("APPDATA env var is not set; this script targets Windows.");
}

const DEFAULTS_PATH = join(APPDATA, "Simularca", "defaults.json");
if (!existsSync(DEFAULTS_PATH)) {
  throw new Error(`No Simularca defaults found at ${DEFAULTS_PATH}.`);
}

const defaults = JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
const projectPointerPath = defaults.path;
const snapshotName = defaults.lastSnapshotName ?? "main";
console.log(`Project pointer: ${projectPointerPath}`);
console.log(`Snapshot: ${snapshotName}`);

const projectFolder = dirname(projectPointerPath);
const pointer = JSON.parse(readFileSync(projectPointerPath, "utf8"));
const projectUuid = pointer.uuid;
const projectName = projectFolder.split(/[\\/]/).pop() ?? "project";
console.log(`Project uuid: ${projectUuid}`);
console.log(`Project name: ${projectName}`);

const snapshotSourcePath = join(projectFolder, "snapshots", `${snapshotName}.json`);
const snapshotRaw = readFileSync(snapshotSourcePath, "utf8");
const snapshot = JSON.parse(snapshotRaw);
const snapshotSchemaVersion = snapshot.schemaVersion ?? 8;
const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
console.log(`Snapshot bytes: ${String(snapshotRaw.length)}`);
console.log(`Asset references: ${String(assets.length)}`);

const DEV_PUBLISH_ROOT = join(REPO_ROOT, "public", "dev-publish");
const SNAPSHOTS_DIR = join(DEV_PUBLISH_ROOT, "snapshots");
const ASSETS_DIR = join(DEV_PUBLISH_ROOT, "assets");
mkdirSync(SNAPSHOTS_DIR, { recursive: true });
mkdirSync(ASSETS_DIR, { recursive: true });

function shortHash(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 12);
}

const snapshotContentSha = shortHash(snapshotRaw);
const snapshotKey = `snapshots/${snapshotName}-${snapshotContentSha}.json`;
const snapshotDest = join(DEV_PUBLISH_ROOT, snapshotKey);
mkdirSync(dirname(snapshotDest), { recursive: true });
writeFileSync(snapshotDest, snapshotRaw);
console.log(`Wrote ${snapshotKey}`);

const assetMap = {};
for (const asset of assets) {
  const sourcePath = join(projectFolder, asset.relativePath);
  if (!existsSync(sourcePath)) {
    console.warn(`SKIP missing asset: ${sourcePath}`);
    continue;
  }
  const sizeMb = (statSync(sourcePath).size / (1024 * 1024)).toFixed(1);
  // Hash the bytes for a content-addressed key. Stream so multi-GB assets
  // don't OOM the staging script.
  const hash = createHash("sha256");
  const fs = await import("node:fs");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(sourcePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const sha = hash.digest("hex");
  const bucketKey = `assets/sha256/${sha}`;
  const dest = join(DEV_PUBLISH_ROOT, bucketKey);
  if (!existsSync(dest)) {
    console.log(`  copy ${sizeMb} MB → ${bucketKey}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(sourcePath, dest);
  } else {
    console.log(`  skip ${sizeMb} MB (already cached at ${bucketKey})`);
  }
  const manifestKey = `${projectUuid}/${asset.relativePath}`;
  // Manifest URLs are POSIX-style bucket-relative paths.
  assetMap[manifestKey] = posix.join("assets", "sha256", sha);
}

// Bundle every installed plugin (mirrors `discoverInstalledPlugins` in
// electron/main.ts) so the dev-publish payload exercises the same loading
// path the real viewer uses against R2.
const { bundlePlugin, resolvePluginEntry } = await import(
  `file:///${join(REPO_ROOT, "dist-electron", "electron", "pluginBundler.js").replaceAll("\\", "/")}`
);
const viewerExternalsPath = join(REPO_ROOT, "viewer-externals.json");
const pluginRoots = [
  join(REPO_ROOT, "plugins-external"),
  join(REPO_ROOT, "plugins")
];
const seenPluginIds = new Set();
const pluginEntries = [];
for (const root of pluginRoots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = join(root, entry.name);
    const pkgPath = join(pluginRoot, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const id = pkg.name ?? entry.name;
    if (seenPluginIds.has(id)) continue;
    let entryPath;
    try {
      entryPath = resolvePluginEntry(pluginRoot);
    } catch {
      continue;
    }
    if (!existsSync(entryPath)) {
      console.warn(`SKIP plugin ${id}: not built (run \`npm run build:plugins\`)`);
      continue;
    }
    seenPluginIds.add(id);
    pluginEntries.push({ id, entryPath, version: pkg.version ?? "0.0.0" });
  }
}

const pluginManifest = [];
for (const plugin of pluginEntries) {
  const bundle = await bundlePlugin({ entryPath: plugin.entryPath, viewerExternalsPath });
  const bucketKey = `plugins/${bundle.sha256}.js`;
  const dest = join(DEV_PUBLISH_ROOT, bucketKey);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(bundle.bytes));
  pluginManifest.push({
    id: plugin.id,
    version: plugin.version,
    url: bucketKey,
    core: false,
    externals: bundle.externals
  });
  console.log(`Bundled plugin ${plugin.id} (${(bundle.byteSize / 1024).toFixed(0)} kB) → ${bucketKey}`);
}

const manifest = {
  manifestVersion: 1,
  publishId: "dev-smoke-test",
  title: projectName,
  publishedAtIso: new Date().toISOString(),
  requiredViewerSha: "dev",
  appBuild: { version: "0.0.0-dev", commitShortSha: "dev" },
  project: { uuid: projectUuid, name: projectName },
  snapshots: [
    {
      name: snapshotName,
      url: snapshotKey,
      schemaVersion: snapshotSchemaVersion,
      default: true
    }
  ],
  assets: assetMap,
  plugins: pluginManifest,
  publishConfigUrl: "publishConfig-dev.json"
};

const manifestSha = shortHash(JSON.stringify(manifest));
const manifestKey = `publishes/dev-smoke-test/manifest-${manifestSha}.json`;
const manifestDest = join(DEV_PUBLISH_ROOT, manifestKey);
mkdirSync(dirname(manifestDest), { recursive: true });
writeFileSync(manifestDest, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${manifestKey}`);

const publishConfig = {
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
const publishConfigKey = `publishes/dev-smoke-test/publishConfig-dev.json`;
writeFileSync(join(DEV_PUBLISH_ROOT, publishConfigKey), JSON.stringify(publishConfig, null, 2));
console.log(`Wrote ${publishConfigKey}`);

const latestKey = `publishes/dev-smoke-test/latest.json`;
writeFileSync(
  join(DEV_PUBLISH_ROOT, latestKey),
  JSON.stringify({ latestVersion: 1, manifestUrl: `manifest-${manifestSha}.json` }, null, 2)
);
console.log(`Wrote ${latestKey}`);

// Dev-escape payload: {bucketBaseUrl, manifest, publishConfig?} consumed by
// src/viewer/main.tsx when ?manifest=<url> is set in DEV mode.
const payload = {
  bucketBaseUrl: "/dev-publish",
  manifest,
  publishConfig
};
writeFileSync(join(DEV_PUBLISH_ROOT, "payload.json"), JSON.stringify(payload, null, 2));
console.log(`Wrote payload.json`);

console.log("");
console.log("Done. Start dev server:");
console.log("  npm run dev:web");
console.log("Then open:");
console.log("  http://localhost:5180/viewer.html?manifest=/dev-publish/payload.json");

import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

import type { PublishTarget } from "./publishStore.js";
import { bundlePlugin, resolvePluginEntry } from "./pluginBundler.js";

/**
 * The R2 upload pipeline used by the `publish:start` IPC handler.
 *
 * Lifecycle (each step is a `PublishProgressEvent`):
 *   1. preflight
 *   2. snapshot-scan      — parse snapshot JSONs to enumerate assets+plugins
 *   3. plugin-bundle      — esbuild each non-core plugin (no-op if none)
 *   4. asset-hash         — stream-SHA256 each unique asset
 *   5. existence-check    — HEAD batch on R2; mark misses
 *   6. asset-upload       — concurrent PUT of misses, with retries
 *   7. plugin-upload
 *   8. snapshot-upload    — content-addressed snapshot JSONs
 *   9. config-upload      — publishConfig-<sha>.json
 *  10. manifest-upload    — manifest-<sha>.json
 *  11. switch-live        — atomic latest.json PUT — publish goes live here
 *  12. gc                 — prune old manifests/snapshots/configs (best-effort)
 *  13. done
 *
 * `latest.json` is written LAST. Anything earlier failing leaves the previous
 * publish intact.
 */

export const PUBLISH_MANIFEST_VERSION = 1;
export const DEFAULT_MANIFEST_RETENTION = 10;
export const ASSET_UPLOAD_CONCURRENCY = 4;
export const ASSET_UPLOAD_RETRIES = 3;

export type PublishPhase =
  | "preflight"
  | "snapshot-scan"
  | "plugin-bundle"
  | "asset-hash"
  | "existence-check"
  | "asset-upload"
  | "plugin-upload"
  | "snapshot-upload"
  | "config-upload"
  | "manifest-upload"
  | "switch-live"
  | "gc"
  | "done"
  | "error";

export interface PublishProgressEvent {
  jobId: string;
  phase: PublishPhase;
  current?: number;
  total?: number;
  currentItem?: string;
  message?: string;
  /** Monotonic 0..1 across the whole publish. Drives a smooth UI progress bar. */
  overallProgress?: number;
  /** When phase === "done", populated with the published viewer URL. */
  viewerUrl?: string;
  manifestSha?: string;
  /** When phase === "error", populated with the error message. */
  error?: string;
}

/**
 * Relative weights assigned to each phase. Sum to 1.0. The progress bar
 * computes its position as `phaseStart + (current/total) * phaseWeight` so
 * the bar moves smoothly forward through the whole publish without snapping
 * back to 0 between phases.
 *
 * Asset-upload gets the biggest slice because it dominates wall-clock time
 * on real-world publishes; the cheap metadata phases are small fixed slices.
 */
const PHASE_WEIGHTS: Record<PublishPhase, number> = {
  preflight: 0.005,
  "snapshot-scan": 0.015,
  "plugin-bundle": 0.02,
  "asset-hash": 0.15,
  "existence-check": 0.1,
  "asset-upload": 0.55,
  "plugin-upload": 0.04,
  "snapshot-upload": 0.04,
  "config-upload": 0.01,
  "manifest-upload": 0.02,
  "switch-live": 0.04,
  gc: 0.005,
  done: 0.005,
  error: 0
};

function computePhaseStart(phase: PublishPhase): number {
  const order: PublishPhase[] = [
    "preflight",
    "snapshot-scan",
    "plugin-bundle",
    "asset-hash",
    "existence-check",
    "asset-upload",
    "plugin-upload",
    "snapshot-upload",
    "config-upload",
    "manifest-upload",
    "switch-live",
    "gc",
    "done"
  ];
  let acc = 0;
  for (const entry of order) {
    if (entry === phase) return acc;
    acc += PHASE_WEIGHTS[entry];
  }
  return acc;
}

function computeOverallProgress(phase: PublishPhase, current?: number, total?: number): number {
  if (phase === "done") return 1;
  if (phase === "error") return 1;
  const start = computePhaseStart(phase);
  const weight = PHASE_WEIGHTS[phase];
  if (!total || total <= 0) {
    // Phase with nothing to do — advance to the end of its slot.
    return Math.min(1, start + weight);
  }
  const ratio = Math.max(0, Math.min(1, (current ?? 0) / total));
  return Math.min(1, start + ratio * weight);
}

export interface PublishedBlobRef {
  sha: string;
  /** Bucket-relative key. */
  key: string;
  byteSize: number;
  kind: "asset" | "plugin" | "snapshot" | "config" | "manifest" | "latest" | "thumbnail";
}

export type PublishProgressCallback = (event: PublishProgressEvent) => void;

export interface PublishViewerConfig {
  configVersion: 1;
  panels: {
    sceneTree: boolean;
    inspector: boolean;
    console: boolean;
    snapshotPicker: boolean;
  };
  interactions: {
    transformGizmo: boolean;
    axisWidget: boolean;
    viewPresets: boolean;
    postProcessing: boolean;
    orbitPanZoom: boolean;
  };
  permissions: {
    canEditParameters: boolean;
    canToggleVisibility: boolean;
    canCreateActors: boolean;
    canDeleteActors: boolean;
    canTransformActors: boolean;
  };
  /** Optional FlexLayout IJsonModel chosen by the publisher. Opaque to the main process. */
  layout?: unknown;
  branding: { title?: string };
}

export interface DiscoveredPluginEntry {
  /** Stable id used in the manifest (typically the package's `name`). */
  id: string;
  /** Absolute path to the plugin's compiled `dist/index.js`. */
  entryPath: string;
  /** Plugin version (from package.json) — best effort. */
  version: string;
}

export interface StartPublishArgs {
  jobId: string;
  /** Stable id per-publish; reuse to update an existing publish; omit for new. */
  publishId?: string;
  projectFolder: string;
  projectUuid: string;
  projectName: string;
  /** Snapshots to include; first one becomes default. */
  snapshotNames: string[];
  title: string;
  viewerConfig: PublishViewerConfig;
  target: PublishTarget;
  /** `BUILD_INFO.commitShortSha` of the editor process. */
  requiredViewerSha: string;
  /** Editor's app version, embedded in `manifest.appBuild`. */
  appVersion: string;
  /** Path to viewer-externals.json (used when bundling plugins). */
  viewerExternalsPath: string;
  /**
   * All non-core plugins available on the publisher's machine. Every entry
   * is bundled and shipped with the publish so the viewer can register
   * descriptors regardless of which actors the snapshot happens to use.
   * (The snapshot's `pluginsEnabled` field is a runtime toggle in the
   * editor and doesn't reliably reflect which plugins the scene needs.)
   */
  discoveredPlugins?: DiscoveredPluginEntry[];
  /**
   * Optional pre-encoded thumbnail captured from the editor viewport. The
   * bytes are uploaded to the publisher's bucket and recorded in
   * `manifest.thumbnail` so the Vercel routing middleware can serve it as
   * `<meta property="og:image">` when the URL is shared on social media.
   */
  thumbnail?: {
    bytes: Buffer;
    width: number;
    height: number;
    contentType: string;
  };
  /** Cancellation signal — checked between phases. */
  signal?: AbortSignal;
  onProgress?: PublishProgressCallback;
}

export interface PublishResult {
  publishId: string;
  manifestSha: string;
  viewerUrl: string;
  requiredViewerSha: string;
  referencedBlobs: PublishedBlobRef[];
}

const SnapshotAssetEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  encoding: z.string().optional(),
  relativePath: z.string(),
  sourceFileName: z.string().optional(),
  byteSize: z.number().optional()
});

const SnapshotMinimalSchema = z
  .object({
    schemaVersion: z.number().int(),
    assets: z.array(SnapshotAssetEntrySchema).default([]),
    pluginsEnabled: z.record(z.string(), z.unknown()).default({}),
    // Actors are stored as an object keyed by actor id; we only need
    // `actorType` to count plugin-owned ones for the pre-flight check.
    actors: z
      .record(
        z.string(),
        z.object({ actorType: z.string().optional() }).passthrough()
      )
      .default({})
  })
  .passthrough();

interface ParsedSnapshot {
  name: string;
  raw: string;
  contentSha: string;
  schemaVersion: number;
  assets: Array<{ relativePath: string; byteSize?: number }>;
  pluginIds: string[];
  /** Count of actors with `actorType === "plugin"`. Drives a sanity check that
   *  the publish actually bundled plugin code when the scene needs it. */
  pluginActorCount: number;
}

interface AssetPlan {
  /** Local absolute path. */
  sourcePath: string;
  /** Original relative path inside the project folder. */
  relativePath: string;
  byteSize: number;
  sha256: string;
  bucketKey: string;
  manifestKey: string;
  contentType: string;
}

interface PluginPlan {
  id: string;
  version: string;
  bytes: Uint8Array;
  sha256: string;
  bucketKey: string;
  externals: Record<string, string>;
  byteSize: number;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".ktx2": "image/ktx2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".hdr": "image/vnd.radiance",
  ".exr": "image/aces",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".fbx": "application/octet-stream",
  ".dae": "model/vnd.collada+xml",
  ".obj": "text/plain; charset=utf-8",
  ".dxf": "application/dxf",
  ".splat": "application/octet-stream",
  ".ply": "application/octet-stream"
};

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MUTABLE_CACHE_CONTROL = "public, max-age=60, must-revalidate";

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function shortContentSha(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function generatePublishId(): string {
  // 16 random bytes → 22 url-safe base64 characters.
  return randomBytes(16).toString("base64url");
}

function buildAssetMapKey(projectUuid: string, relativePath: string): string {
  return `${projectUuid}/${relativePath}`;
}

function buildR2Client(target: PublishTarget): S3Client {
  return new S3Client({
    region: target.r2.region ?? "auto",
    endpoint: `https://${target.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: target.r2.accessKeyId,
      secretAccessKey: target.r2.secretAccessKey
    },
    // R2 doesn't honor S3's checksum headers; opt out to avoid 400s.
    forcePathStyle: false
  });
}

async function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || status === 412) {
      return false;
    }
    throw error;
  }
}

interface PutObjectArgs {
  body: Uint8Array | NodeJS.ReadableStream;
  contentType: string;
  cacheControl: string;
}

async function putObjectWithRetry(
  client: S3Client,
  bucket: string,
  key: string,
  args: PutObjectArgs,
  retries: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: args.body as Buffer | Uint8Array,
          ContentType: args.contentType,
          CacheControl: args.cacheControl
        })
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
      const backoffMs = Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError ?? new Error(`PUT failed after ${String(retries + 1)} attempts: ${key}`);
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Publish cancelled.");
  }
}

async function readSnapshot(
  projectFolder: string,
  snapshotName: string
): Promise<ParsedSnapshot> {
  const snapshotPath = path.join(projectFolder, "snapshots", `${snapshotName}.json`);
  const raw = await fsp.readFile(snapshotPath, "utf8");
  const parsed = SnapshotMinimalSchema.parse(JSON.parse(raw));
  const pluginActorCount = Object.values(parsed.actors).filter(
    (actor) => actor.actorType === "plugin"
  ).length;
  return {
    name: snapshotName,
    raw,
    contentSha: shortContentSha(raw),
    schemaVersion: parsed.schemaVersion,
    assets: parsed.assets.map((entry) => ({ relativePath: entry.relativePath, byteSize: entry.byteSize })),
    pluginIds: Object.keys(parsed.pluginsEnabled),
    pluginActorCount
  };
}

function dedupeAssets(snapshots: ParsedSnapshot[]): Array<{ relativePath: string; byteSize?: number }> {
  const seen = new Map<string, { relativePath: string; byteSize?: number }>();
  for (const snap of snapshots) {
    for (const asset of snap.assets) {
      if (!seen.has(asset.relativePath)) {
        seen.set(asset.relativePath, asset);
      }
    }
  }
  return Array.from(seen.values());
}

async function uploadInPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
  signal: AbortSignal | undefined
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          checkAborted(signal);
          const idx = cursor;
          cursor += 1;
          const item = items[idx];
          if (item === undefined) continue;
          await worker(item, idx);
        }
      })()
    );
  }
  await Promise.all(runners);
}

export async function startPublish(args: StartPublishArgs): Promise<PublishResult> {
  const { onProgress, signal, jobId } = args;
  const referencedBlobs: PublishedBlobRef[] = [];
  const recordBlob = (blob: PublishedBlobRef): void => {
    // Replace by sha — re-publishes on the same content shouldn't double-count.
    const existing = referencedBlobs.findIndex((entry) => entry.sha === blob.sha);
    if (existing >= 0) referencedBlobs.splice(existing, 1);
    referencedBlobs.push(blob);
  };
  const emit = (event: Omit<PublishProgressEvent, "jobId">): void => {
    const overallProgress = event.overallProgress ?? computeOverallProgress(event.phase, event.current, event.total);
    onProgress?.({ jobId, ...event, overallProgress });
  };

  emit({ phase: "preflight", message: "Validating publish target..." });
  if (args.snapshotNames.length === 0) {
    throw new Error("At least one snapshot is required.");
  }
  const baseUrl = trimTrailingSlash(args.target.bucketBaseUrl);
  void baseUrl;
  const publishId = args.publishId ?? generatePublishId();
  const r2 = buildR2Client(args.target);
  const bucket = args.target.r2.bucket;

  // 2. Scan snapshots
  emit({ phase: "snapshot-scan", current: 0, total: args.snapshotNames.length });
  const snapshots: ParsedSnapshot[] = [];
  for (let i = 0; i < args.snapshotNames.length; i += 1) {
    checkAborted(signal);
    const name = args.snapshotNames[i];
    if (!name) continue;
    const parsed = await readSnapshot(args.projectFolder, name);
    snapshots.push(parsed);
    emit({
      phase: "snapshot-scan",
      current: i + 1,
      total: args.snapshotNames.length,
      currentItem: name
    });
  }

  const uniqueAssets = dedupeAssets(snapshots);

  // 3. Plugin bundling. We bundle ALL discovered plugins (not just the
  //    snapshot's `pluginsEnabled` keys), because actor descriptors come
  //    from plugins and the snapshot doesn't reliably encode which ones
  //    are needed. The viewer registers them all on boot; unused plugins
  //    are benign metadata overhead.
  const plugins = args.discoveredPlugins ?? [];
  // Defensive de-dup by id (in case of multiple discovery roots returning the same plugin).
  const seenPluginIds = new Set<string>();
  const uniquePlugins = plugins.filter((p) => {
    if (seenPluginIds.has(p.id)) return false;
    seenPluginIds.add(p.id);
    return true;
  });
  emit({ phase: "plugin-bundle", current: 0, total: uniquePlugins.length });
  const pluginPlans: PluginPlan[] = [];
  for (let i = 0; i < uniquePlugins.length; i += 1) {
    checkAborted(signal);
    const plugin = uniquePlugins[i];
    if (!plugin) continue;
    try {
      const bundle = await bundlePlugin({
        entryPath: plugin.entryPath,
        viewerExternalsPath: args.viewerExternalsPath
      });
      pluginPlans.push({
        id: plugin.id,
        version: plugin.version,
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        bucketKey: `plugins/${bundle.sha256}.js`,
        externals: bundle.externals,
        byteSize: bundle.byteSize
      });
      emit({
        phase: "plugin-bundle",
        current: i + 1,
        total: uniquePlugins.length,
        currentItem: `${plugin.id} (${(bundle.byteSize / 1024).toFixed(0)} kB)`
      });
    } catch (error) {
      emit({
        phase: "plugin-bundle",
        current: i + 1,
        total: uniquePlugins.length,
        currentItem: plugin.id,
        message: `WARNING: failed to bundle ${plugin.id}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  if (uniquePlugins.length === 0) {
    emit({ phase: "plugin-bundle", current: 0, total: 0 });
  }

  // Guardrail: if the scene contains plugin actors but no plugin bundles
  // got produced, the published viewer will silently fail to render those
  // actors. Refuse to continue with a message the user can act on. This
  // catches both "no plugins discovered" (e.g. plugins/dist not built) and
  // "every plugin failed to bundle" (the per-plugin try/catch above only
  // emits warnings).
  const expectedPluginActors = snapshots.reduce(
    (sum, snap) => sum + snap.pluginActorCount,
    0
  );
  if (expectedPluginActors > 0 && pluginPlans.length === 0) {
    throw new Error(
      `Scene references ${expectedPluginActors.toString()} plugin actor(s) but no plugin bundles were produced. ` +
        `Run \`npm run build:plugins\` and confirm plugins/ and plugins-external/ contain compiled dist/index.js entries, then publish again.`
    );
  }

  // 4. Asset hashing
  emit({ phase: "asset-hash", current: 0, total: uniqueAssets.length });
  const assetPlans: AssetPlan[] = [];
  for (let i = 0; i < uniqueAssets.length; i += 1) {
    checkAborted(signal);
    const asset = uniqueAssets[i];
    if (!asset) continue;
    const sourcePath = path.join(args.projectFolder, asset.relativePath);
    const stat = statSync(sourcePath);
    const sha = await streamSha256(sourcePath);
    assetPlans.push({
      sourcePath,
      relativePath: asset.relativePath,
      byteSize: stat.size,
      sha256: sha,
      bucketKey: `assets/sha256/${sha}`,
      manifestKey: buildAssetMapKey(args.projectUuid, asset.relativePath),
      contentType: contentTypeFor(asset.relativePath)
    });
    emit({
      phase: "asset-hash",
      current: i + 1,
      total: uniqueAssets.length,
      currentItem: asset.relativePath
    });
  }

  // 5. Existence check (HEAD batch). Done concurrently with the same pool size.
  emit({ phase: "existence-check", current: 0, total: assetPlans.length + pluginPlans.length });
  const assetMissing: AssetPlan[] = [];
  const pluginMissing: PluginPlan[] = [];
  let checked = 0;
  const allKeys: Array<
    | { kind: "asset"; plan: AssetPlan }
    | { kind: "plugin"; plan: PluginPlan }
  > = [
    ...assetPlans.map((plan) => ({ kind: "asset" as const, plan })),
    ...pluginPlans.map((plan) => ({ kind: "plugin" as const, plan }))
  ];
  await uploadInPool(
    allKeys,
    async (entry) => {
      const key = entry.plan.bucketKey;
      const exists = await objectExists(r2, bucket, key);
      if (!exists) {
        if (entry.kind === "asset") {
          assetMissing.push(entry.plan);
        } else {
          pluginMissing.push(entry.plan);
        }
      }
      checked += 1;
      emit({
        phase: "existence-check",
        current: checked,
        total: allKeys.length,
        currentItem: key
      });
    },
    ASSET_UPLOAD_CONCURRENCY,
    signal
  );

  // 6. Asset upload (misses only). Every asset (uploaded or skipped) is still
  //    referenced by this publish so we record its blob regardless.
  for (const asset of assetPlans) {
    recordBlob({
      sha: asset.sha256,
      key: asset.bucketKey,
      byteSize: asset.byteSize,
      kind: "asset"
    });
  }
  emit({ phase: "asset-upload", current: 0, total: assetMissing.length });
  let assetUploaded = 0;
  await uploadInPool(
    assetMissing,
    async (asset) => {
      const stream = createReadStream(asset.sourcePath);
      await putObjectWithRetry(
        r2,
        bucket,
        asset.bucketKey,
        {
          body: stream,
          contentType: asset.contentType,
          cacheControl: ASSET_CACHE_CONTROL
        },
        ASSET_UPLOAD_RETRIES
      );
      assetUploaded += 1;
      emit({
        phase: "asset-upload",
        current: assetUploaded,
        total: assetMissing.length,
        currentItem: asset.relativePath
      });
    },
    ASSET_UPLOAD_CONCURRENCY,
    signal
  );
  // If no misses, still emit an end-of-phase tick so the overall progress
  // bar advances past asset-upload.
  if (assetMissing.length === 0) {
    emit({ phase: "asset-upload", current: 0, total: 0, message: "All assets already uploaded; nothing to do." });
  }

  // 7. Plugin upload (misses only). Record every referenced plugin regardless.
  for (const plugin of pluginPlans) {
    recordBlob({
      sha: plugin.sha256,
      key: plugin.bucketKey,
      byteSize: plugin.byteSize,
      kind: "plugin"
    });
  }
  emit({ phase: "plugin-upload", current: 0, total: pluginMissing.length });
  let pluginUploaded = 0;
  for (const plugin of pluginMissing) {
    checkAborted(signal);
    await putObjectWithRetry(
      r2,
      bucket,
      plugin.bucketKey,
      {
        body: plugin.bytes,
        contentType: "application/javascript; charset=utf-8",
        cacheControl: ASSET_CACHE_CONTROL
      },
      ASSET_UPLOAD_RETRIES
    );
    pluginUploaded += 1;
    emit({
      phase: "plugin-upload",
      current: pluginUploaded,
      total: pluginMissing.length,
      currentItem: plugin.id
    });
  }
  if (pluginMissing.length === 0) {
    emit({ phase: "plugin-upload", current: 0, total: 0 });
  }

  // 8. Snapshot upload
  emit({ phase: "snapshot-upload", current: 0, total: snapshots.length });
  const snapshotEntries: Array<{
    name: string;
    url: string;
    schemaVersion: number;
    default: boolean;
  }> = [];
  for (let i = 0; i < snapshots.length; i += 1) {
    checkAborted(signal);
    const snap = snapshots[i];
    if (!snap) continue;
    const key = `publishes/${publishId}/snapshots/${snap.name}-${snap.contentSha}.json`;
    await putObjectWithRetry(
      r2,
      bucket,
      key,
      {
        body: Buffer.from(snap.raw, "utf8"),
        contentType: "application/json; charset=utf-8",
        cacheControl: ASSET_CACHE_CONTROL
      },
      ASSET_UPLOAD_RETRIES
    );
    snapshotEntries.push({
      name: snap.name,
      // URLs in the manifest are BUCKET-relative (i.e. relative to
      // `bucketBaseUrl`), not relative to the manifest's own directory.
      // The viewer's web adapter does `bucketBaseUrl + "/" + url`.
      url: key,
      schemaVersion: snap.schemaVersion,
      default: i === 0
    });
    recordBlob({
      sha: snap.contentSha,
      key,
      byteSize: Buffer.byteLength(snap.raw, "utf8"),
      kind: "snapshot"
    });
    emit({
      phase: "snapshot-upload",
      current: i + 1,
      total: snapshots.length,
      currentItem: snap.name
    });
  }

  // 9. publishConfig upload
  emit({ phase: "config-upload", current: 0, total: 1 });
  const configRaw = JSON.stringify(args.viewerConfig, null, 2);
  const configSha = shortContentSha(configRaw);
  const configKey = `publishes/${publishId}/publishConfig-${configSha}.json`;
  // Same bucket-relative convention as snapshot URLs above.
  const publishConfigUrl = configKey;
  await putObjectWithRetry(
    r2,
    bucket,
    configKey,
    {
      body: Buffer.from(configRaw, "utf8"),
      contentType: "application/json; charset=utf-8",
      cacheControl: ASSET_CACHE_CONTROL
    },
    ASSET_UPLOAD_RETRIES
  );
  recordBlob({
    sha: configSha,
    key: configKey,
    byteSize: Buffer.byteLength(configRaw, "utf8"),
    kind: "config"
  });
  emit({ phase: "config-upload", current: 1, total: 1 });

  // 9b. Thumbnail upload (optional). Content-addressed so re-publishing
  // the same image is a no-op and stale thumbnails are GC'd along with
  // their manifest. The image is the OpenGraph social-card image served
  // by the viewer routing middleware.
  let thumbnailManifestEntry: { url: string; width: number; height: number; contentType: string } | undefined;
  if (args.thumbnail) {
    checkAborted(signal);
    const thumb = args.thumbnail;
    const ext = thumb.contentType === "image/png" ? "png" : "jpg";
    const thumbSha = shortContentSha(thumb.bytes);
    const thumbKey = `publishes/${publishId}/thumbnail-${thumbSha}.${ext}`;
    await putObjectWithRetry(
      r2,
      bucket,
      thumbKey,
      {
        body: thumb.bytes,
        contentType: thumb.contentType,
        cacheControl: ASSET_CACHE_CONTROL
      },
      ASSET_UPLOAD_RETRIES
    );
    recordBlob({
      sha: thumbSha,
      key: thumbKey,
      byteSize: thumb.bytes.byteLength,
      kind: "thumbnail"
    });
    thumbnailManifestEntry = {
      url: thumbKey,
      width: thumb.width,
      height: thumb.height,
      contentType: thumb.contentType
    };
  }

  // 10. Manifest build + upload
  const assetMap: Record<string, string> = {};
  for (const plan of assetPlans) {
    assetMap[plan.manifestKey] = plan.bucketKey;
  }

  const manifest = {
    manifestVersion: PUBLISH_MANIFEST_VERSION,
    publishId,
    title: args.title,
    publishedAtIso: new Date().toISOString(),
    requiredViewerSha: args.requiredViewerSha,
    appBuild: { version: args.appVersion, commitShortSha: args.requiredViewerSha },
    project: { uuid: args.projectUuid, name: args.projectName },
    snapshots: snapshotEntries,
    assets: assetMap,
    plugins: pluginPlans.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      url: plugin.bucketKey,
      core: false,
      externals: plugin.externals
    })),
    publishConfigUrl,
    ...(thumbnailManifestEntry ? { thumbnail: thumbnailManifestEntry } : {})
  };
  const manifestRaw = JSON.stringify(manifest, null, 2);
  const manifestSha = shortContentSha(manifestRaw);
  const manifestKey = `publishes/${publishId}/manifest-${manifestSha}.json`;
  emit({ phase: "manifest-upload", current: 0, total: 1, manifestSha });
  await putObjectWithRetry(
    r2,
    bucket,
    manifestKey,
    {
      body: Buffer.from(manifestRaw, "utf8"),
      contentType: "application/json; charset=utf-8",
      cacheControl: ASSET_CACHE_CONTROL
    },
    ASSET_UPLOAD_RETRIES
  );
  recordBlob({
    sha: manifestSha,
    key: manifestKey,
    byteSize: Buffer.byteLength(manifestRaw, "utf8"),
    kind: "manifest"
  });
  emit({ phase: "manifest-upload", current: 1, total: 1, manifestSha });

  // 11. Atomic switch via latest.json. Publish becomes live here.
  emit({ phase: "switch-live", current: 0, total: 1 });
  const latestKey = `publishes/${publishId}/latest.json`;
  const latestPayload = JSON.stringify(
    { latestVersion: 1, manifestUrl: `manifest-${manifestSha}.json` },
    null,
    2
  );
  await putObjectWithRetry(
    r2,
    bucket,
    latestKey,
    {
      body: Buffer.from(latestPayload, "utf8"),
      contentType: "application/json; charset=utf-8",
      cacheControl: MUTABLE_CACHE_CONTROL
    },
    ASSET_UPLOAD_RETRIES
  );
  recordBlob({
    sha: `latest-${manifestSha}`,
    key: latestKey,
    byteSize: Buffer.byteLength(latestPayload, "utf8"),
    kind: "latest"
  });
  emit({ phase: "switch-live", current: 1, total: 1 });

  // 12. GC — best-effort, doesn't block return.
  // Listing R2 objects requires `s3:ListBucket`. We don't want to require
  // that permission, so for this MVP we skip GC and document it as a
  // future enhancement. (The on-disk publish-settings entry tracks history
  // even without R2 listing.)
  emit({ phase: "gc", current: 0, total: 0, message: "GC skipped (requires ListBucket permission; future enhancement)." });

  const viewerBucketParam = encodeURIComponent(trimTrailingSlash(args.target.bucketBaseUrl));
  const viewerUrl = `${trimTrailingSlash(args.target.viewerUrl)}/v/${encodeURIComponent(args.requiredViewerSha)}/p/${encodeURIComponent(publishId)}?b=${viewerBucketParam}`;
  emit({ phase: "done", viewerUrl, manifestSha });

  return { publishId, manifestSha, viewerUrl, requiredViewerSha: args.requiredViewerSha, referencedBlobs };
}

/** Convenience re-export so callers can build their own plugin-discovery maps. */
export { resolvePluginEntry };

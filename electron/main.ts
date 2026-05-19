import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, screen, shell, type OpenDialogOptions } from "electron";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRenderPipeFrameBytes } from "./renderPipeFrameBytes.js";
import { RotoControlHost } from "./rotoControlHost.js";
import {
  SIMULARCA_EXTENSION,
  type DefaultProjectPointer,
  type DaeImportResult,
  type FileDialogFilter,
  type GitDirtyBadge,
  type GitDirtyStatusRequest,
  type GitDirtyStatusResponse,
  type HdriTranscodeOptions,
  type LegacyProjectInfo,
  type OpenProjectResult,
  type ProjectAssetRef,
  type ProjectIdentity,
  type ProjectionCacheFileV1,
  type ProjectSnapshotListEntry,
  type RecentsEntry,
  type RotoControlBank,
  type RotoControlDawEmulation,
  type RotoControlInputEvent,
  type RotoControlState
} from "../src/types/ipc.js";
import { isIgnorablePipeError, startLiveDebugServer, type LiveDebugServerController } from "./liveDebugServer.js";
import { toCompactYaml } from "./loggerUtils.js";
import {
  createPointer,
  discoverAllSimularcaFiles,
  discoverSimularcaFile,
  pointerFilePath,
  projectNameFromSimularcaPath,
  readPointer,
  repairPointer,
  writePointer
} from "./projectPointer.js";
import {
  findRecentByUuid,
  loadRecents,
  removeRecentByUuid,
  saveRecents,
  updateRecentPath
} from "./recentsStore.js";
import {
  PUBLISH_SETTINGS_FILE_NAME,
  findTarget,
  loadPublishSettings,
  recordPublish,
  redactSettings,
  savePublishSettings,
  setDefaultPublishLayout,
  setDefaultViewerPermissions,
  type PublishSettings,
  type PublishTarget
} from "./publishStore.js";
import {
  startPublish,
  type DiscoveredPluginEntry,
  type PublishProgressEvent as ServicePublishProgressEvent
} from "./publishService.js";
import { resolvePluginEntry } from "./pluginBundler.js";
import {
  checkViewerVersion as checkViewerVersionRemote,
  deployViewer,
  ensureVercelProject,
  verifyVercelToken,
  type DeployViewerProgressEvent
} from "./vercelDeploy.js";
import { verifyTarget, type VerifyTargetResult } from "./publishVerify.js";
import { DeleteObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type {
  ListedPublish,
  PublishCheckViewerVersionRequest,
  PublishCheckViewerVersionResult,
  PublishDeleteResult,
  PublishProgressEvent,
  PublishRollbackRequest,
  PublishStartAck,
  PublishStartRequest,
  PublishTargetWriteRequest,
  RedactedPublishSettings
} from "../src/types/ipc.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg"]);
// 1×1 transparent PNG
const FALLBACK_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=",
  "base64"
);

const ANSI_COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m"
} as const;

const SCOPE_COLORS: Record<string, string> = {
  "renderer-console": ANSI_COLORS.cyan,
  "app": ANSI_COLORS.green,
  "boot": ANSI_COLORS.magenta,
  "window": ANSI_COLORS.blue,
  "webcontents": ANSI_COLORS.yellow,
  "process": ANSI_COLORS.red,
  "renderer": ANSI_COLORS.red,
  "render:pipe": ANSI_COLORS.magenta,
  "render:temp": ANSI_COLORS.magenta,
  "asset-protocol": ANSI_COLORS.dim
};

type LogSeverity = "error" | "warn" | "info";

const SEVERITY_COLORS: Record<LogSeverity, string> = {
  error: ANSI_COLORS.red,
  warn: ANSI_COLORS.yellow,
  info: ANSI_COLORS.white
};

let logLastTime: Date | null = null;

interface PendingDedup {
  key: string;            // scope:message:serializedMetadata — for exact-match dedup
  scope: string;
  message: string;
  metadata: unknown;
  severity: LogSeverity;
  count: number;
  lastTime: Date;
  timestamp: string;              // formatted timestamp from first write (reused on rewrites)
  terminalNewlineCount: number;   // lines written to stdout (for cursor-up rewrite)
  fileOffset: number;             // byte offset in log file before this entry (-1 = unknown)
}
let pendingDedup: PendingDedup | null = null;
const LOG_DEDUP_WINDOW_MS = 60_000;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

if (IS_DEV) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

const APP_DISPLAY_NAME = "Simularca";

// Set the app name BEFORE anything that resolves userData — crashReporter.start
// in particular reads app.getPath() which caches "Electron" as the directory
// name if the rename hasn't happened yet, which then orphans recents.json.
app.setName(APP_DISPLAY_NAME);

// Diagnostic switches — must be set before app emits 'ready'.
// Remote debugging exposes Chrome DevTools Protocol so a frozen renderer can
// be inspected from outside the main process even if our IPC bridge is starved.
const REMOTE_DEBUGGING_PORT = "9222";
if (IS_DEV) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);
  // Don't let Chromium auto-disable the GPU process after a few crashes — we want
  // every crash visible in the runtime log instead of silent fallback.
  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
}

// Native (V8/GPU) crashes write minidumps to userData/Crashpad/reports. Local-only.
crashReporter.start({
  productName: APP_DISPLAY_NAME,
  companyName: "Kimchi and Chips",
  uploadToServer: false,
  ignoreSystemCrashHandler: false
});
const DEFAULTS_FILE_NAME = "defaults.json";
const RUNTIME_LOG_FILE_NAME = "electron-runtime.log";
const WINDOW_STATE_FILE_NAME = "window-state.json";
const ASSET_PROTOCOL = "simularca-asset";
const DEFAULT_WINDOW_WIDTH = 1680;
const DEFAULT_WINDOW_HEIGHT = 960;
const MIN_WINDOW_WIDTH = 1200;
const MIN_WINDOW_HEIGHT = 720;
const APP_ICON_FILE_NAME = "icon.png";
const CODEX_DEBUG_MANIFEST_FILE_NAME = "codex-debug-session.json";
const RENDER_PIPE_QUEUE_BUDGET_BYTES = 256 * 1024 * 1024;
interface RenderPipeJob {
  child: ReturnType<typeof spawn>;
  encoder: string;
  outputPath: string;
  sender: Electron.WebContents;
  queue: Buffer[];
  queuedBytes: number;
  queueBudgetBytes: number;
  acceptedFrameCount: number;
  writtenFrameCount: number;
  acceptingFrames: boolean;
  aborted: boolean;
  error: Error | null;
  pumpPromise: Promise<void> | null;
  childClosePromise: Promise<void>;
}
const renderPipeJobs = new Map<string, RenderPipeJob>();
const renderTempJobs = new Map<
  string,
  {
    frameFolderPath: string;
    framePatternPath: string;
    outputPath: string;
    fps: number;
    bitrateMbps: number;
    encoder: string;
    pendingWrites: Set<Promise<void>>;
  }
>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

function getRepoRoot(): string {
  return process.cwd();
}

function getLogsRoot(): string {
  return path.join(getRepoRoot(), "logs");
}

function getUserDataRoot(): string {
  return app.getPath("userData");
}

function getRecentsFilePath(): string {
  return path.join(getUserDataRoot(), "recents.json");
}

function getDefaultsFilePath(): string {
  return path.join(getUserDataRoot(), DEFAULTS_FILE_NAME);
}

function getDocumentsProjectsRoot(): string {
  return path.join(app.getPath("documents"), "Simularca Projects");
}

const SNAPSHOTS_DIR = "snapshots";
const ASSETS_DIR = "assets";

function projectFolderForPath(simularcaPath: string): string {
  return path.dirname(simularcaPath);
}

function snapshotsDirForPath(simularcaPath: string): string {
  return path.join(projectFolderForPath(simularcaPath), SNAPSHOTS_DIR);
}

function snapshotFileForPath(simularcaPath: string, snapshotName: string): string {
  return path.join(snapshotsDirForPath(simularcaPath), `${snapshotName}.json`);
}

function assetsDirForPath(simularcaPath: string, kind?: ProjectAssetRef["kind"]): string {
  const root = path.join(projectFolderForPath(simularcaPath), ASSETS_DIR);
  return kind ? path.join(root, kind) : root;
}

/**
 * Maps the in-session uuid → project folder path. Populated when the renderer
 * opens a project; consulted by the simularca-asset:// protocol handler when
 * resolving asset URLs that encode the uuid.
 */
const openProjectFoldersByUuid = new Map<string, string>();

function rememberProjectFolder(identity: ProjectIdentity): void {
  openProjectFoldersByUuid.set(identity.uuid, projectFolderForPath(identity.path));
}

function forgetProjectFolder(uuid: string): void {
  openProjectFoldersByUuid.delete(uuid);
}

function getAppIconPath(): string {
  return path.join(getRepoRoot(), APP_ICON_FILE_NAME);
}

function configureAppIcon(): string | undefined {
  const iconPath = getAppIconPath();
  if (!fsSync.existsSync(iconPath)) {
    void writeRuntimeLog("app", "App icon file not found", { iconPath }, "warn");
    return undefined;
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    void writeRuntimeLog("app", "App icon could not be loaded", { iconPath }, "warn");
    return undefined;
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(icon);
  }
  return iconPath;
}

function getRuntimeLogFilePath(): string {
  return path.join(getLogsRoot(), RUNTIME_LOG_FILE_NAME);
}

function getCodexDebugManifestFilePath(): string {
  return path.join(getLogsRoot(), CODEX_DEBUG_MANIFEST_FILE_NAME);
}

function toErrorPayload(input: unknown): Record<string, unknown> {
  if (input instanceof Error) {
    const result: Record<string, unknown> = {
      name: input.name,
      message: input.message,
    };
    if (input.stack) {
      result.stack = input.stack;
    }
    return result;
  }
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  return {
    value: String(input)
  };
}

function safeWriteToStream(stream: NodeJS.WriteStream | undefined, line: string): void {
  if (!stream || stream.destroyed || !stream.writable) {
    return;
  }
  try {
    stream.write(`${line}\n`);
  } catch (error) {
    if (!isIgnorablePipeError(error)) {
      try {
        process.stderr.write(`[logger] ${String(error)}\n`);
      } catch {
        // Ignore secondary logging failures.
      }
    }
  }
}

function installBrokenPipeGuards(): void {
  process.stdout.on("error", (error) => {
    if (!isIgnorablePipeError(error)) {
      throw error;
    }
  });
  process.stderr.on("error", (error) => {
    if (!isIgnorablePipeError(error)) {
      throw error;
    }
  });
}

function formatLogTimestamp(now: Date): string {
  const timeStr = now.toISOString().slice(11, 19) + "Z";
  const deltaMs = logLastTime !== null ? now.getTime() - logLastTime.getTime() : 0;
  logLastTime = now;
  return `${timeStr} +${deltaMs}ms`;
}

function buildLogLines(
  scope: string,
  message: string,
  metadata: unknown,
  severity: LogSeverity,
  timestamp: string,
  repeatCount: number
): { fileLine: string; terminalLine: string; terminalNewlineCount: number } {
  const metadataPayload = metadata === undefined ? undefined : toErrorPayload(metadata);
  const metadataYaml = metadataPayload === undefined ? "" : `\n${toCompactYaml(metadataPayload, 1).trimEnd()}`;
  const countSuffix = repeatCount > 1 ? ` (repeats ${repeatCount} times)` : "";

  const fileLine = `[${timestamp}] [${scope}] ${message}${countSuffix}${metadataYaml}`;

  const scopeColor = severity !== "info" ? SEVERITY_COLORS[severity] : (SCOPE_COLORS[scope] ?? ANSI_COLORS.white);
  const coloredScope = `${scopeColor}${scope}${ANSI_COLORS.reset}`;
  const coloredTimestamp = `${ANSI_COLORS.dim}${timestamp}${ANSI_COLORS.reset}`;
  const coloredMessage = severity !== "info" ? `${scopeColor}${message}${ANSI_COLORS.reset}` : message;
  const coloredCountSuffix = repeatCount > 1 ? ` ${ANSI_COLORS.dim}(repeats ${repeatCount} times)${ANSI_COLORS.reset}` : "";
  const terminalLine = `[${coloredTimestamp}] [${coloredScope}] ${coloredMessage}${coloredCountSuffix}${metadataYaml}`;
  const terminalNewlineCount = (terminalLine.match(/\n/g)?.length ?? 0) + 1;

  return { fileLine, terminalLine, terminalNewlineCount };
}

function initializeRuntimeLog(): void {
  const now = new Date();
  logLastTime = now;
  pendingDedup = null;
  const header = [
    "=== Simularca Runtime Log ===",
    `Session Start: ${now.toISOString().slice(0, 19)}Z`,
    `Platform:      ${process.platform}`,
    `Node:          ${process.version}`,
    "===================================",
    ""
  ].join("\n");
  try {
    fsSync.mkdirSync(getLogsRoot(), { recursive: true });
    fsSync.writeFileSync(getRuntimeLogFilePath(), `${header}\n`, "utf8");
  } catch (error) {
    safeWriteToStream(process.stderr, `[logger] Failed to initialize runtime log ${JSON.stringify(toErrorPayload(error))}`);
  }
}

function writeRuntimeLog(scope: string, message: string, metadata?: unknown, severity: LogSeverity = "info"): void {
  const now = new Date();
  const metadataKey = metadata === undefined ? "" : JSON.stringify(toErrorPayload(metadata));
  const key = `${scope}:${message}:${metadataKey}`;

  if (pendingDedup !== null) {
    if (pendingDedup.key === key && (now.getTime() - pendingDedup.lastTime.getTime()) < LOG_DEDUP_WINDOW_MS) {
      // Same message+body within window: rewrite in place with updated count
      pendingDedup.count++;
      pendingDedup.lastTime = now;
      const { fileLine, terminalLine, terminalNewlineCount } = buildLogLines(
        pendingDedup.scope, pendingDedup.message, pendingDedup.metadata,
        pendingDedup.severity, pendingDedup.timestamp, pendingDedup.count
      );
      // Terminal: cursor-up + clear + rewrite (TTY only; piped output just appends)
      if (process.stdout.isTTY) {
        try {
          process.stdout.write(`\x1b[${pendingDedup.terminalNewlineCount}A\r\x1b[J${terminalLine}\n`);
        } catch { /* ignore */ }
      } else {
        safeWriteToStream(process.stdout, terminalLine);
      }
      pendingDedup.terminalNewlineCount = terminalNewlineCount;
      // File: truncate back to entry start + rewrite
      if (pendingDedup.fileOffset >= 0) {
        try {
          const filePath = getRuntimeLogFilePath();
          fsSync.truncateSync(filePath, pendingDedup.fileOffset);
          fsSync.appendFileSync(filePath, `${fileLine}\n`, "utf8");
        } catch { /* ignore */ }
      }
      return;
    }
    // Different message: previous entry already has the correct count, just reset
    pendingDedup = null;
  }

  // Fresh write
  const timestamp = formatLogTimestamp(now);
  const { fileLine, terminalLine, terminalNewlineCount } = buildLogLines(
    scope, message, metadata, severity, timestamp, 1
  );

  safeWriteToStream(process.stdout, terminalLine);

  let fileOffset = -1;
  try {
    fsSync.mkdirSync(getLogsRoot(), { recursive: true });
    const filePath = getRuntimeLogFilePath();
    try { fileOffset = fsSync.statSync(filePath).size; } catch { /* file may not exist yet */ }
    fsSync.appendFileSync(filePath, `${fileLine}\n`, "utf8");
  } catch (error) {
    safeWriteToStream(process.stderr, `[logger] Failed to write runtime log ${JSON.stringify(toErrorPayload(error))}`);
  }

  pendingDedup = {
    key, scope, message, metadata, severity,
    count: 1, lastTime: now,
    timestamp, terminalNewlineCount, fileOffset
  };
}

installBrokenPipeGuards();
initializeRuntimeLog();

void writeRuntimeLog("boot", "electron main module loaded", {
  cwd: process.cwd(),
  node: process.version,
  platform: process.platform
});

let liveDebugServerController: LiveDebugServerController | null = null;
let rotoControlHost: RotoControlHost | null = null;
const closingConfirmedWindows = new WeakSet<BrowserWindow>();

/** Legacy savedata location, kept for migration only. */
function getLegacySaveDataRoot(): string {
  return path.join(getRepoRoot(), "savedata");
}

/** Legacy project folder layout, kept for migration only. */
function getLegacyProjectDirectory(projectName: string): string {
  return path.join(getLegacySaveDataRoot(), projectName);
}

interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

function getWindowStateFilePath(): string {
  return path.join(getUserDataRoot(), WINDOW_STATE_FILE_NAME);
}

function getLegacyWindowStateFilePath(): string {
  return path.join(getLegacySaveDataRoot(), WINDOW_STATE_FILE_NAME);
}

function migrateLegacyWindowState(): void {
  const legacyPath = getLegacyWindowStateFilePath();
  const newPath = getWindowStateFilePath();
  try {
    if (!fsSync.existsSync(legacyPath)) {
      return;
    }
    if (fsSync.existsSync(newPath)) {
      return;
    }
    fsSync.mkdirSync(path.dirname(newPath), { recursive: true });
    fsSync.copyFileSync(legacyPath, newPath);
    void writeRuntimeLog("window", "Migrated legacy window state to userData", {
      from: legacyPath,
      to: newPath
    });
  } catch (error) {
    void writeRuntimeLog("window", "Failed to migrate legacy window state", error, "warn");
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampWindowDimension(value: number, min: number): number {
  return Math.max(min, Math.floor(value));
}

function readPersistedWindowState(): PersistedWindowState | null {
  const filePath = getWindowStateFilePath();
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;
    if (!isFiniteNumber(parsed.width) || !isFiniteNumber(parsed.height)) {
      return null;
    }
    const next: PersistedWindowState = {
      width: clampWindowDimension(parsed.width, MIN_WINDOW_WIDTH),
      height: clampWindowDimension(parsed.height, MIN_WINDOW_HEIGHT)
    };
    if (isFiniteNumber(parsed.x)) {
      next.x = Math.floor(parsed.x);
    }
    if (isFiniteNumber(parsed.y)) {
      next.y = Math.floor(parsed.y);
    }
    if (typeof parsed.isMaximized === "boolean") {
      next.isMaximized = parsed.isMaximized;
    }
    return next;
  } catch (error) {
    void writeRuntimeLog("window", "Failed to read persisted window state", error, "warn");
    return null;
  }
}

function isWindowBoundsVisible(state: PersistedWindowState): boolean {
  if (!isFiniteNumber(state.x) || !isFiniteNumber(state.y)) {
    return true;
  }
  const bounds = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  };
  const display = screen.getDisplayMatching(bounds);
  return (
    bounds.x < display.bounds.x + display.bounds.width &&
    bounds.x + bounds.width > display.bounds.x &&
    bounds.y < display.bounds.y + display.bounds.height &&
    bounds.y + bounds.height > display.bounds.y
  );
}

function persistWindowState(state: PersistedWindowState): void {
  try {
    fsSync.mkdirSync(getUserDataRoot(), { recursive: true });
    fsSync.writeFileSync(getWindowStateFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    void writeRuntimeLog("window", "Failed to persist window state", error, "warn");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readSnapshotUpdatedAtIso(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && typeof parsed.updatedAtIso === "string" && parsed.updatedAtIso.trim().length > 0) {
      return parsed.updatedAtIso;
    }
  } catch {
    // Fall back to file metadata below.
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readPluginPackageVersion(packageJsonPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Parse the `version: "..."` literal out of `pluginBuildInfo.generated.ts`.
 * This is the version baked into the plugin module at build time, which is
 * the authoritative answer when `dist/package.json` is stale or missing.
 */
async function readPluginGeneratedVersion(generatedPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(generatedPath, "utf8");
    const match = /\bversion\s*:\s*"([^"]+)"/.exec(raw);
    const captured = match?.[1]?.trim();
    if (captured && captured.length > 0) {
      return captured;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the count of commits reachable from the plugin's standalone git HEAD.
 * External plugins (under `plugins-external/<plugin>`) are separate git
 * repositories whose commit history is the natural progression signal — the
 * baseline version in their `package.json` is just a placeholder, so we
 * append the commit count to it so the published manifest reflects real
 * authorship progression instead of being stuck at the baseline forever.
 */
function tryReadPluginGitCommitCount(pluginDir: string): number | null {
  try {
    const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: pluginDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const count = Number.parseInt(out, 10);
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function bumpPatchVersion(baseVersion: string, addPatch: number): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(baseVersion.trim());
  if (!match || !match[1] || !match[2] || !match[3]) return baseVersion;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10) + Math.max(0, addPatch);
  return `${String(major)}.${String(minor)}.${String(patch)}`;
}

/**
 * Resolve the most accurate version string for a plugin by walking the
 * fallback chain: built `dist/pluginBuildInfo.generated.ts` → built
 * `dist/package.json` (bumped by plugin-build.mjs) → source
 * `src/pluginBuildInfo.generated.ts` (what the running plugin reports as
 * `PLUGIN_VERSION`) → source `package.json`. Finally, if the plugin lives in
 * its own git repo, append the plugin-local commit count as a patch bump so
 * external plugins whose bundled build scripts don't derive versions from git
 * still get a meaningful, monotonically-advancing version.
 */
async function resolvePluginVersion(pluginDir: string): Promise<string> {
  const candidates: Array<() => Promise<string | null>> = [
    () => readPluginGeneratedVersion(path.join(pluginDir, "dist", "pluginBuildInfo.generated.ts")),
    async () => {
      const distPackageJson = path.join(pluginDir, "dist", "package.json");
      if (!(await fileExists(distPackageJson))) return null;
      const value = await readPluginPackageVersion(distPackageJson);
      return value === "0.0.0" ? null : value;
    },
    () => readPluginGeneratedVersion(path.join(pluginDir, "src", "pluginBuildInfo.generated.ts")),
    async () => {
      const sourcePackageJson = path.join(pluginDir, "package.json");
      if (!(await fileExists(sourcePackageJson))) return null;
      const value = await readPluginPackageVersion(sourcePackageJson);
      return value === "0.0.0" ? null : value;
    }
  ];
  let baseVersion: string | null = null;
  for (const candidate of candidates) {
    const value = await candidate();
    if (value !== null) {
      baseVersion = value;
      break;
    }
  }
  if (baseVersion === null) baseVersion = "0.0.0";

  // If a `.git` directory sits inside this plugin directory, treat it as a
  // standalone plugin git repo and bump the patch by commit count.
  if (await fileExists(path.join(pluginDir, ".git"))) {
    const commitCount = tryReadPluginGitCommitCount(pluginDir);
    if (commitCount !== null && commitCount > 0) {
      return bumpPatchVersion(baseVersion, commitCount);
    }
  }
  return baseVersion;
}

async function discoverExternalPlugins(): Promise<Array<{ modulePath: string; sourceGroup: "plugins-external" | "plugins"; updatedAtMs: number; version: string }>> {
  const roots: Array<{ sourceGroup: "plugins-external" | "plugins"; directory: string }> = [
    { sourceGroup: "plugins-external", directory: path.join(getRepoRoot(), "plugins-external") },
    { sourceGroup: "plugins", directory: path.join(getRepoRoot(), "plugins") }
  ];
  const discovered: Array<{ modulePath: string; sourceGroup: "plugins-external" | "plugins"; updatedAtMs: number; version: string }> = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root.directory, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      for (const childName of directories) {
        const pluginDir = path.join(root.directory, childName);
        const builtEntry = path.join(pluginDir, "dist", "index.js");
        try {
          const stat = await fs.stat(builtEntry);
          discovered.push({
            modulePath: `file:///${builtEntry.replaceAll("\\", "/")}`,
            sourceGroup: root.sourceGroup,
            updatedAtMs: stat.mtimeMs,
            version: await resolvePluginVersion(pluginDir)
          });
        } catch {
          // Ignore entries without built output.
        }
      }
    } catch {
      // Directory missing or inaccessible; ignore.
    }
  }
  return discovered;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function tryFindGitRoot(startPath: string): string | null {
  try {
    return path.resolve(runGit(["rev-parse", "--show-toplevel"], startPath));
  } catch {
    return null;
  }
}

function countDirtyFiles(gitRoot: string): number | null {
  try {
    const porcelain = runGit(["status", "--porcelain"], gitRoot);
    if (!porcelain) {
      return 0;
    }
    return porcelain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return null;
  }
}

function resolveModuleFilePath(modulePath: string): string | null {
  try {
    const parsed = new URL(modulePath);
    if (parsed.protocol !== "file:") {
      return null;
    }
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

function buildGitDirtyBadge(repoRoot: string | null, changedFileCount: number | null): GitDirtyBadge | null {
  if (!repoRoot || changedFileCount === null) {
    return null;
  }
  return {
    repoRoot,
    changedFileCount
  };
}

function getGitDirtyStatus(args: GitDirtyStatusRequest): GitDirtyStatusResponse {
  if (!IS_DEV) {
    return {
      app: null,
      plugins: {}
    };
  }

  const appRepoRoot = tryFindGitRoot(getRepoRoot());
  const countsByRepoRoot = new Map<string, number | null>();
  const getRepoCount = (repoRoot: string): number | null => {
    const normalizedRepoRoot = path.resolve(repoRoot);
    if (!countsByRepoRoot.has(normalizedRepoRoot)) {
      countsByRepoRoot.set(normalizedRepoRoot, countDirtyFiles(normalizedRepoRoot));
    }
    return countsByRepoRoot.get(normalizedRepoRoot) ?? null;
  };

  const plugins: Record<string, GitDirtyBadge | null> = {};
  for (const modulePath of args.pluginModulePaths) {
    const moduleFilePath = resolveModuleFilePath(modulePath);
    const moduleDir = moduleFilePath ? path.dirname(moduleFilePath) : null;
    const pluginRepoRoot = moduleDir ? tryFindGitRoot(moduleDir) : null;
    if (!pluginRepoRoot || (appRepoRoot && path.resolve(pluginRepoRoot) === path.resolve(appRepoRoot))) {
      plugins[modulePath] = null;
      continue;
    }
    plugins[modulePath] = buildGitDirtyBadge(pluginRepoRoot, getRepoCount(pluginRepoRoot));
  }

  return {
    app: buildGitDirtyBadge(appRepoRoot, appRepoRoot ? getRepoCount(appRepoRoot) : null),
    plugins
  };
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ply":
      return "application/octet-stream";
    case ".hdr":
      return "image/vnd.radiance";
    case ".exr":
      return "image/aces";
    case ".ktx2":
      return "image/ktx2";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

async function registerAssetProtocol(): Promise<void> {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    try {
      const parsed = new URL(request.url);
      const projectUuid = decodeURIComponent(parsed.hostname);
      const projectFolder = openProjectFoldersByUuid.get(projectUuid);
      if (!projectFolder) {
        void writeRuntimeLog("asset-protocol", "Unknown project uuid", { uuid: projectUuid }, "warn");
        return new Response("Unknown project", { status: 404 });
      }
      const relativeParts = parsed.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));
      const relativePath = relativeParts.join("/");
      const projectRoot = path.resolve(projectFolder);
      const targetPath = path.resolve(projectRoot, relativePath);
      if (!targetPath.startsWith(projectRoot)) {
        return new Response("Invalid asset path", { status: 400 });
      }
      // Stream the file directly using Chromium's native file loader —
      // avoids reading the entire file into a Buffer in the main process
      // and eliminates the large IPC data transfer to the renderer.
      const fileResponse = await net.fetch(pathToFileURL(targetPath).href);
      if (fileResponse.ok) {
        // Preserve our explicit MIME type mapping (Chromium's defaults differ for .ktx2, .ply etc.)
        return new Response(fileResponse.body, {
          status: 200,
          headers: { "content-type": mimeTypeForPath(targetPath) }
        });
      }
      // File not found — fall through to image fallback
      const ext = path.extname(targetPath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        return new Response(FALLBACK_IMAGE_PNG, {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Path resolution error or unexpected net.fetch failure
      try {
        const parsed = new URL(request.url);
        const ext = path.extname(parsed.pathname).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          return new Response(FALLBACK_IMAGE_PNG, {
            status: 200,
            headers: { "content-type": "image/png" }
          });
        }
      } catch {
        // ignore
      }
      void writeRuntimeLog("asset-protocol", "Failed to resolve request", {
        url: request.url,
        error
      }, "warn");
      return new Response("Not found", { status: 404 });
    }
  });
}

async function ensureProjectFolderStructure(simularcaPath: string): Promise<void> {
  const folder = projectFolderForPath(simularcaPath);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(snapshotsDirForPath(simularcaPath), { recursive: true });
  await fs.mkdir(assetsDirForPath(simularcaPath), { recursive: true });
}

async function loadDefaultsFromUserData(): Promise<DefaultProjectPointer | null> {
  const defaultsPath = getDefaultsFilePath();
  try {
    const raw = await fs.readFile(defaultsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as DefaultProjectPointer).uuid === "string" &&
      typeof (parsed as DefaultProjectPointer).path === "string"
    ) {
      const candidate = parsed as DefaultProjectPointer;
      return {
        uuid: candidate.uuid,
        path: candidate.path,
        lastSnapshotName: candidate.lastSnapshotName ?? null
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveDefaultsToUserData(pointer: DefaultProjectPointer | null): Promise<void> {
  const defaultsPath = getDefaultsFilePath();
  await fs.mkdir(path.dirname(defaultsPath), { recursive: true });
  if (pointer === null) {
    try {
      await fs.rm(defaultsPath, { force: true });
    } catch {
      // Ignore.
    }
    return;
  }
  await fs.writeFile(defaultsPath, JSON.stringify(pointer, null, 2), "utf8");
}

async function copyDirectoryRecursive(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function readFolderEntryCount(folder: string): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(folder);
  return count;
}

async function readFolderTotalBytes(folder: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          total += stat.size;
        } catch {
          // Skip unreadable.
        }
      }
    }
  }
  await walk(folder);
  return total;
}

async function runToktx({
  inputPath,
  outputPath,
  options
}: {
  inputPath: string;
  outputPath: string;
  options?: HdriTranscodeOptions;
}): Promise<void> {
  const args = [
    "--t2",
    "--encode",
    options?.uastc === false ? "etc1s" : "uastc",
    "--zcmp",
    String(options?.zstdLevel ?? 18)
  ];

  if (options?.generateMipmaps ?? true) {
    args.push("--genmipmap");
  }

  args.push(outputPath, inputPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("toktx", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderrBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new Error(`Unable to run toktx: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `toktx failed with code ${String(code)}. Ensure KTX-Software is installed and toktx is on PATH. ${stderrBuffer}`.trim()
        )
      );
    });
  });
}

function ffmpegPath(): string {
  return "ffmpeg";
}

async function detectH265Encoder(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-encoders"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`Unable to run ffmpeg: ${error.message}`));
    });
    child.on("close", () => {
      if (/\bhevc_nvenc\b/.test(text)) {
        resolve("hevc_nvenc");
        return;
      }
      if (/\blibx265\b/.test(text)) {
        resolve("libx265");
        return;
      }
      reject(new Error("No H.265 encoder found. Install FFmpeg with hevc_nvenc or libx265."));
    });
  });
}

function bitrateArg(bitrateMbps: number): string {
  const safe = Number.isFinite(bitrateMbps) ? Math.max(1, Math.floor(bitrateMbps)) : 100;
  return `${String(safe)}M`;
}

function emitRenderPipeState(jobId: string, job: RenderPipeJob): void {
  if (job.sender.isDestroyed()) {
    return;
  }
  job.sender.send("render:pipe-state", {
    pipeId: jobId,
    acceptedFrameCount: job.acceptedFrameCount,
    writtenFrameCount: job.writtenFrameCount,
    queuedBytes: job.queuedBytes,
    queueBudgetBytes: job.queueBudgetBytes,
    error: job.error?.message,
    closed: !job.acceptingFrames
  });
}

function writeChildStdin(
  writable: NodeJS.WritableStream & { destroyed?: boolean },
  chunk: Buffer
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (writable.destroyed) {
      reject(new Error("Render pipe stdin is unavailable."));
      return;
    }
    let settled = false;
    let callbackDone = false;
    let drainDone = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      writable.off("error", onError);
      writable.off("drain", onDrain);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const maybeResolve = () => {
      if (callbackDone && drainDone) {
        finish();
      }
    };
    const onError = (error: Error) => finish(error);
    const onDrain = () => {
      drainDone = true;
      maybeResolve();
    };
    writable.on("error", onError);
    const ok = writable.write(chunk, (error) => {
      if (error) {
        finish(error);
        return;
      }
      callbackDone = true;
      maybeResolve();
    });
    if (ok) {
      drainDone = true;
    } else {
      writable.once("drain", onDrain);
    }
  });
}

function scheduleRenderPipePump(jobId: string, job: RenderPipeJob): void {
  if (job.pumpPromise || job.aborted || job.error) {
    return;
  }
  job.pumpPromise = (async () => {
    while (!job.aborted && !job.error) {
      const next = job.queue.shift();
      if (!next) {
        break;
      }
      job.queuedBytes = Math.max(0, job.queuedBytes - next.byteLength);
      emitRenderPipeState(jobId, job);
      const writable = job.child.stdin;
      if (!writable || writable.destroyed) {
        throw new Error("Render pipe stdin is unavailable.");
      }
      await writeChildStdin(writable, next);
      job.writtenFrameCount += 1;
      emitRenderPipeState(jobId, job);
    }
  })().catch((error) => {
    job.error = error instanceof Error ? error : new Error(String(error));
    emitRenderPipeState(jobId, job);
  }).finally(() => {
    job.pumpPromise = null;
    if (job.queue.length > 0 && !job.aborted && !job.error) {
      scheduleRenderPipePump(jobId, job);
    }
  });
}

function pipeEncodeArgs(args: {
  fps: number;
  bitrateMbps: number;
  encoder: string;
  outputPath: string;
}): string[] {
  const fps = Math.max(1, Math.floor(args.fps));
  return [
    "-y",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-framerate",
    String(fps),
    "-i",
    "-",
    "-an",
    "-c:v",
    args.encoder,
    "-tag:v",
    "hvc1",
    "-b:v",
    bitrateArg(args.bitrateMbps),
    "-pix_fmt",
    "yuv420p",
    args.outputPath
  ];
}

function tempEncodeArgs(args: {
  fps: number;
  bitrateMbps: number;
  encoder: string;
  framePatternPath: string;
  outputPath: string;
}): string[] {
  const fps = Math.max(1, Math.floor(args.fps));
  return [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    args.framePatternPath,
    "-an",
    "-c:v",
    args.encoder,
    "-tag:v",
    "hvc1",
    "-b:v",
    bitrateArg(args.bitrateMbps),
    "-pix_fmt",
    "yuv420p",
    args.outputPath
  ];
}

function createWindow(): BrowserWindow {
  const persisted = readPersistedWindowState();
  const usePersistedBounds = persisted && isWindowBoundsVisible(persisted);
  const iconPath = configureAppIcon();
  const mainWindow = new BrowserWindow({
    width: usePersistedBounds ? persisted.width : DEFAULT_WINDOW_WIDTH,
    height: usePersistedBounds ? persisted.height : DEFAULT_WINDOW_HEIGHT,
    x: usePersistedBounds && isFiniteNumber(persisted.x) ? persisted.x : undefined,
    y: usePersistedBounds && isFiniteNumber(persisted.y) ? persisted.y : undefined,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    backgroundColor: "#0a0f17",
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(getRepoRoot(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Renderer-side plugins that drive USB-MIDI hardware control surfaces (e.g.
  // the Electra One surface plugin) use the browser Web MIDI API, including
  // SysEx (navigator.requestMIDIAccess({ sysex: true })). Electra is MIDI-only
  // — there is no Node-side MIDI host for it — so the renderer must be allowed
  // the midi/midiSysex permissions. Before this app set no permission handler,
  // which meant Electron's default of granting permission requests applied;
  // these handlers preserve that behaviour while making the MIDI grant explicit
  // (the `MIDI_PERMISSIONS` check documents intent — the effective result is
  // unchanged for every other permission).
  const MIDI_PERMISSIONS = new Set(["midi", "midiSysex"]);
  const windowSession = mainWindow.webContents.session;
  windowSession.setPermissionCheckHandler((_webContents, permission) => {
    if (MIDI_PERMISSIONS.has(permission)) {
      return true;
    }
    // Behaviour-preserving: matches Electron's prior no-handler default.
    return true;
  });
  windowSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (MIDI_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    // Behaviour-preserving: matches Electron's prior no-handler default.
    callback(true);
  });

  void writeRuntimeLog("window", "Creating BrowserWindow", {
    isDev: IS_DEV,
    devServerUrl: DEV_SERVER_URL ?? null
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
      void writeRuntimeLog("webcontents", "did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
        frameProcessId,
        frameRoutingId
      }, "error");
    }
  );

  mainWindow.webContents.on("did-finish-load", () => {
    void writeRuntimeLog("webcontents", "did-finish-load", {
      url: mainWindow.webContents.getURL()
    });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void writeRuntimeLog("webcontents", "render-process-gone", details, "error");
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    void writeRuntimeLog("webcontents", "preload-error", {
      preloadPath,
      error: toErrorPayload(error)
    }, "error");
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level <= 1) {
      return;
    }
    const consoleSeverity: LogSeverity = level >= 3 ? "error" : "warn";
    void writeRuntimeLog("renderer-console", "console-message", {
      level,
      message,
      line,
      sourceId
    }, consoleSeverity);
  });

  mainWindow.on("unresponsive", () => {
    let rendererPid: number | undefined;
    try {
      rendererPid = mainWindow.webContents.getOSProcessId();
    } catch { /* ignore */ }
    void writeRuntimeLog(
      "window",
      "BrowserWindow became unresponsive",
      {
        rendererPid,
        mainMemoryUsage: process.memoryUsage()
      },
      "warn"
    );
  });
  mainWindow.on("responsive", () => {
    void writeRuntimeLog("window", "BrowserWindow recovered (responsive)");
  });

  mainWindow.on("closed", () => {
    void writeRuntimeLog("window", "BrowserWindow closed");
    void liveDebugServerController?.refreshManifest();
  });

  let persistTimeout: ReturnType<typeof setTimeout> | null = null;
  const persistCurrentWindowState = () => {
    const normalBounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    persistWindowState({
      width: clampWindowDimension(normalBounds.width, MIN_WINDOW_WIDTH),
      height: clampWindowDimension(normalBounds.height, MIN_WINDOW_HEIGHT),
      x: Math.floor(normalBounds.x),
      y: Math.floor(normalBounds.y),
      isMaximized: mainWindow.isMaximized()
    });
  };
  const queuePersistWindowState = () => {
    if (persistTimeout) {
      clearTimeout(persistTimeout);
    }
    persistTimeout = setTimeout(() => {
      persistCurrentWindowState();
      persistTimeout = null;
    }, 150);
  };

  const pushWindowState = () => {
    mainWindow.webContents.send("window:state", {
      isMaximized: mainWindow.isMaximized(),
      isFullscreen: mainWindow.isFullScreen()
    });
  };
  mainWindow.on("maximize", pushWindowState);
  mainWindow.on("unmaximize", pushWindowState);
  mainWindow.on("enter-full-screen", pushWindowState);
  mainWindow.on("leave-full-screen", pushWindowState);
  mainWindow.on("maximize", queuePersistWindowState);
  mainWindow.on("unmaximize", queuePersistWindowState);
  mainWindow.on("moved", queuePersistWindowState);
  mainWindow.on("resized", queuePersistWindowState);
  mainWindow.on("close", (event) => {
    persistCurrentWindowState();
    if (closingConfirmedWindows.has(mainWindow)) {
      closingConfirmedWindows.delete(mainWindow);
      return;
    }
    event.preventDefault();
    mainWindow.webContents.send("window:before-close");
  });
  mainWindow.webContents.once("did-finish-load", () => {
    pushWindowState();
  });

  if (persisted?.isMaximized) {
    mainWindow.maximize();
  }

  if (IS_DEV && DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL).catch((error) => {
      void writeRuntimeLog("window", "Failed to load DEV server URL", error, "error");
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html")).catch((error) => {
      void writeRuntimeLog("window", "Failed to load production index.html", error, "error");
    });
  }

  void liveDebugServerController?.refreshManifest();

  return mainWindow;
}

function registerIpcHandlers(): void {
  ipcMain.on("renderer:runtime-error", (_event, payload: unknown) => {
    void writeRuntimeLog("renderer", "runtime-error", payload, "error");
  });
  // Heartbeat: renderer posts memory + GPU resource counts every ~30s.
  // Kept on a separate scope ("renderer-stats") so it never collides with error
  // dedup, and so it can be filtered from the log easily.
  ipcMain.on("renderer:runtime-stats", (_event, payload: unknown) => {
    void writeRuntimeLog("renderer-stats", "heartbeat", payload, "info");
  });

  ipcMain.handle("mode:get", () => "electron-rw");
  ipcMain.handle("window:get-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { isMaximized: win?.isMaximized() ?? false, isFullscreen: win?.isFullScreen() ?? false };
  });
  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
      return;
    }
    win.maximize();
  });
  ipcMain.handle("window:set-fullscreen", (event, fullscreen: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { isMaximized: false, isFullscreen: false };
    }
    win.setFullScreen(Boolean(fullscreen));
    return { isMaximized: win.isMaximized(), isFullscreen: win.isFullScreen() };
  });
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });
  ipcMain.handle("window:confirm-close", (event, action: "save-and-quit" | "quit" | "cancel") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || action === "cancel") return;
    closingConfirmedWindows.add(win);
    win.close();
  });
  ipcMain.handle("menu:show-app", (event, args: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    const menu = Menu.buildFromTemplate([
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      { role: "help", submenu: [{ label: APP_DISPLAY_NAME, enabled: false }] }
    ]);
    menu.popup({
      window: win,
      x: Math.max(0, Math.floor(args.x)),
      y: Math.max(0, Math.floor(args.y))
    });
  });

  ipcMain.handle("roto-control:connect", async () => {
    if (!rotoControlHost) {
      throw new Error("Roto-Control host unavailable.");
    }
    return await rotoControlHost.connect();
  });
  ipcMain.handle("roto-control:refresh", async () => {
    if (!rotoControlHost) {
      throw new Error("Roto-Control host unavailable.");
    }
    return await rotoControlHost.refresh();
  });
  ipcMain.handle("roto-control:set-serial-override", async (_event, path: string | null) => {
    if (!rotoControlHost) {
      throw new Error("Roto-Control host unavailable.");
    }
    return await rotoControlHost.setSerialPortOverride(path);
  });
  ipcMain.handle("roto-control:set-daw-emulation", async (_event, mode: RotoControlDawEmulation) => {
    if (!rotoControlHost) {
      throw new Error("Roto-Control host unavailable.");
    }
    return await rotoControlHost.setDawEmulation(mode);
  });
  ipcMain.handle("roto-control:publish-bank", async (_event, bank: RotoControlBank) => {
    if (!rotoControlHost) {
      throw new Error("Roto-Control host unavailable.");
    }
    await rotoControlHost.publishBank(bank);
  });

  ipcMain.handle(
    "dialog:open-file",
    async (
      event,
      args: {
        title?: string;
        filters?: FileDialogFilter[];
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: OpenDialogOptions = {
        title: args.title ?? "Select file",
        properties: ["openFile"],
        filters: args.filters
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) {
        return null;
      }
      return result.filePaths[0] ?? null;
    }
  );
  ipcMain.handle(
    "dialog:save-file",
    async (
      event,
      args: {
        title?: string;
        defaultFileName?: string;
        filters?: FileDialogFilter[];
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: args.title ?? "Save file",
            defaultPath: args.defaultFileName,
            filters: args.filters
          })
        : await dialog.showSaveDialog({
            title: args.title ?? "Save file",
            defaultPath: args.defaultFileName,
            filters: args.filters
          });
      if (result.canceled) {
        return null;
      }
      return result.filePath ?? null;
    }
  );
  ipcMain.handle(
    "dialog:open-directory",
    async (
      event,
      args: {
        title?: string;
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: args.title ?? "Choose folder",
            properties: ["openDirectory", "createDirectory"]
          })
        : await dialog.showOpenDialog({
            title: args.title ?? "Choose folder",
            properties: ["openDirectory", "createDirectory"]
          });
      if (result.canceled) {
        return null;
      }
      return result.filePaths[0] ?? null;
    }
  );

  ipcMain.handle("plugins:discover-external", async () => {
    return await discoverExternalPlugins();
  });
  ipcMain.handle("git:dirty-status", async (_event, args: GitDirtyStatusRequest) => {
    return getGitDirtyStatus(args);
  });
  ipcMain.handle(
    "clipboard:write-image-png",
    async (
      _event,
      args: {
        pngBytes: Uint8Array;
      }
    ) => {
      const image = nativeImage.createFromBuffer(Buffer.from(args.pngBytes));
      if (image.isEmpty()) {
        throw new Error("Clipboard image is empty.");
      }
      clipboard.writeImage(image);
    }
  );
  ipcMain.handle(
    "render:pipe-open",
    async (
      event,
      args: {
        outputPath: string;
        fps: number;
        bitrateMbps: number;
      }
    ) => {
      const encoder = await detectH265Encoder();
      const pipeId = randomUUID();
      const ffmpegArgs = pipeEncodeArgs({
        fps: args.fps,
        bitrateMbps: args.bitrateMbps,
        encoder,
        outputPath: args.outputPath
      });
      const child = spawn(ffmpegPath(), ffmpegArgs, {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderrText = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        void writeRuntimeLog("render:pipe", "ffmpeg spawn failed", error, "error");
      });
      (child as any).__stderrTextRef = () => stderrText;
      const childClosePromise = new Promise<void>((resolve, reject) => {
        child.once("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`ffmpeg exited with code ${String(code)}. ${stderrText}`.trim()));
        });
      });
      renderPipeJobs.set(pipeId, {
        child,
        encoder,
        outputPath: args.outputPath,
        sender: event.sender,
        queue: [],
        queuedBytes: 0,
        queueBudgetBytes: RENDER_PIPE_QUEUE_BUDGET_BYTES,
        acceptedFrameCount: 0,
        writtenFrameCount: 0,
        acceptingFrames: true,
        aborted: false,
        error: null,
        pumpPromise: null,
        childClosePromise
      });
      emitRenderPipeState(pipeId, renderPipeJobs.get(pipeId)!);
      return {
        pipeId,
        encoder,
        queueBudgetBytes: RENDER_PIPE_QUEUE_BUDGET_BYTES
      };
    }
  );
  ipcMain.on(
    "render:pipe-write-frame",
    (
      _event,
      args: {
        pipeId: string;
        framePngBytes: Uint8Array | ArrayBuffer;
      }
    ) => {
      const job = renderPipeJobs.get(args.pipeId);
      if (!job) {
        return;
      }
      if (!job.acceptingFrames || job.aborted || job.error) {
        emitRenderPipeState(args.pipeId, job);
        return;
      }
      let buffer: Buffer;
      try {
        buffer = normalizeRenderPipeFrameBytes(args.framePngBytes);
      } catch (error) {
        job.error = error instanceof Error ? error : new Error(String(error));
        job.acceptingFrames = false;
        emitRenderPipeState(args.pipeId, job);
        return;
      }
      job.queue.push(buffer);
      job.queuedBytes += buffer.byteLength;
      job.acceptedFrameCount += 1;
      emitRenderPipeState(args.pipeId, job);
      if (job.queuedBytes > job.queueBudgetBytes) {
        job.error = new Error("Render pipe queue exceeded its budget.");
        emitRenderPipeState(args.pipeId, job);
        return;
      }
      scheduleRenderPipePump(args.pipeId, job);
    }
  );
  ipcMain.handle(
    "render:pipe-close",
    async (
      _event,
      args: {
        pipeId: string;
      }
    ) => {
      const job = renderPipeJobs.get(args.pipeId);
      if (!job) {
        throw new Error("Render pipe job not found.");
      }
      renderPipeJobs.delete(args.pipeId);
      job.acceptingFrames = false;
      emitRenderPipeState(args.pipeId, job);
      while (job.pumpPromise) {
        await job.pumpPromise;
      }
      if (job.error) {
        throw job.error;
      }
      const stdin = job.child.stdin;
      if (stdin && !stdin.destroyed) {
        stdin.end();
      }
      await job.childClosePromise;
      return {
        summary: `Saved ${job.outputPath} (${job.encoder})`
      };
    }
  );
  ipcMain.handle(
    "render:pipe-abort",
    async (
      _event,
      args: {
        pipeId: string;
      }
    ) => {
      const job = renderPipeJobs.get(args.pipeId);
      if (!job) {
        return;
      }
      renderPipeJobs.delete(args.pipeId);
      job.acceptingFrames = false;
      job.child.kill("SIGTERM");
    }
  );
  ipcMain.handle(
    "render:temp-init",
    async (
      _event,
      args: {
        folderPath: string;
        fps: number;
        bitrateMbps: number;
        outputFileName?: string;
        frameFolderName?: string;
      }
    ) => {
      const encoder = await detectH265Encoder();
      const safeFolder = path.resolve(args.folderPath);
      await fs.mkdir(safeFolder, { recursive: true });
      const jobId = randomUUID();
      const rawFrameFolderName =
        typeof args.frameFolderName === "string" && args.frameFolderName.trim().length > 0
          ? args.frameFolderName
          : `frames-${jobId}`;
      // eslint-disable-next-line no-control-regex
      const safeFrameFolderName = rawFrameFolderName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
      const frameFolderPath = path.join(safeFolder, safeFrameFolderName || `frames-${jobId}`);
      await fs.mkdir(frameFolderPath, { recursive: true });
      const outputPath = path.join(safeFolder, args.outputFileName && args.outputFileName.trim() ? args.outputFileName : "render.mp4");
      const framePatternPath = path.join(frameFolderPath, "frame_%06d.png");
      renderTempJobs.set(jobId, {
        frameFolderPath,
        framePatternPath,
        outputPath,
        fps: Math.max(1, Math.floor(args.fps)),
        bitrateMbps: Math.max(1, Math.floor(args.bitrateMbps)),
        encoder,
        pendingWrites: new Set()
      });
      return {
        jobId,
        frameFolderPath,
        outputPath,
        encoder
      };
    }
  );
  ipcMain.handle(
    "render:temp-write-frame",
    async (
      _event,
      args: {
        jobId: string;
        frameIndex: number;
        framePngBytes: Uint8Array;
      }
    ) => {
      const job = renderTempJobs.get(args.jobId);
      if (!job) {
        throw new Error("Render temp job not found.");
      }
      const frameName = `frame_${String(Math.max(0, Math.floor(args.frameIndex))).padStart(6, "0")}.png`;
      const framePath = path.join(job.frameFolderPath, frameName);
      while (job.pendingWrites.size >= 4) {
        await Promise.race(job.pendingWrites);
      }
      const pending = fs.writeFile(framePath, Buffer.from(args.framePngBytes)).finally(() => {
        job.pendingWrites.delete(pending);
      });
      job.pendingWrites.add(pending);
    }
  );
  ipcMain.handle(
    "render:temp-finalize",
    async (
      _event,
      args: {
        jobId: string;
      }
    ) => {
      const job = renderTempJobs.get(args.jobId);
      if (!job) {
        throw new Error("Render temp job not found.");
      }
      renderTempJobs.delete(args.jobId);
      if (job.pendingWrites.size > 0) {
        await Promise.all([...job.pendingWrites]);
      }
      const ffmpegArgs = tempEncodeArgs({
        fps: job.fps,
        bitrateMbps: job.bitrateMbps,
        encoder: job.encoder,
        framePatternPath: job.framePatternPath,
        outputPath: job.outputPath
      });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegPath(), ffmpegArgs, {
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stderrText = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderrText += chunk.toString("utf8");
        });
        child.on("error", (error) => reject(new Error(`Unable to run ffmpeg: ${error.message}`)));
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`ffmpeg exited with code ${String(code)}. ${stderrText}`));
        });
      });
      return {
        summary: `Saved ${job.outputPath} (${job.encoder})`
      };
    }
  );
  ipcMain.handle(
    "render:temp-abort",
    async (
      _event,
      args: {
        jobId: string;
      }
    ) => {
      renderTempJobs.delete(args.jobId);
    }
  );

  ipcMain.handle("recents:load", async (): Promise<RecentsEntry[]> => {
    return loadRecents(getRecentsFilePath());
  });

  ipcMain.handle("recents:save", async (_event, entries: RecentsEntry[]): Promise<void> => {
    await saveRecents(getRecentsFilePath(), entries);
  });

  ipcMain.handle("recents:remove", async (_event, args: { uuid: string }): Promise<void> => {
    const entries = await loadRecents(getRecentsFilePath());
    await saveRecents(getRecentsFilePath(), removeRecentByUuid(entries, args.uuid));
  });

  ipcMain.handle(
    "recents:locate",
    async (event, args: { uuid: string; title?: string }): Promise<RecentsEntry | null> => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const dialogOptions: OpenDialogOptions = {
        title: args.title ?? "Locate project",
        properties: ["openFile"],
        filters: [{ name: "Simularca Project", extensions: ["simularca"] }]
      };
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const picked = result.filePaths[0]!;
      const pointer = await readPointer(picked);
      if (pointer.uuid !== args.uuid) {
        throw new Error(
          `Selected file is a different project (uuid mismatch). Use "Open…" to add it as a new entry.`
        );
      }
      const entries = await loadRecents(getRecentsFilePath());
      const previous = findRecentByUuid(entries, args.uuid);
      const now = new Date().toISOString();
      const next: RecentsEntry = {
        uuid: pointer.uuid,
        path: picked,
        cachedName: projectNameFromSimularcaPath(picked),
        lastOpenedAtIso: previous?.lastOpenedAtIso ?? now,
        lastSnapshotName: previous?.lastSnapshotName ?? null
      };
      await saveRecents(getRecentsFilePath(), updateRecentPath(entries, args.uuid, picked, next.cachedName));
      return next;
    }
  );

  ipcMain.handle("defaults:load", async (): Promise<DefaultProjectPointer | null> => {
    return loadDefaultsFromUserData();
  });

  ipcMain.handle("defaults:save", async (_event, pointer: DefaultProjectPointer | null): Promise<void> => {
    await saveDefaultsToUserData(pointer);
  });

  ipcMain.handle(
    "dialog:select-simularca",
    async (event, args: { title?: string } = {}): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const dialogOptions: OpenDialogOptions = {
        title: args.title ?? "Open project",
        properties: ["openFile"],
        filters: [{ name: "Simularca Project", extensions: ["simularca"] }]
      };
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
    }
  );

  ipcMain.handle(
    "dialog:select-folder",
    async (event, args: { title?: string; defaultPath?: string } = {}): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const dialogOptions: OpenDialogOptions = {
        title: args.title ?? "Select folder",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: args.defaultPath ?? getDocumentsProjectsRoot()
      };
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
    }
  );

  ipcMain.handle("paths:default-projects-root", async (): Promise<string> => getDocumentsProjectsRoot());

  ipcMain.handle(
    "project:create-new",
    async (
      _event,
      args: { parentFolder?: string; projectName: string; initialSnapshotPayload: string }
    ): Promise<ProjectIdentity> => {
      const trimmedName = args.projectName.trim();
      if (!trimmedName) {
        throw new Error("Project name is required.");
      }
      const parent = args.parentFolder?.trim() ? args.parentFolder : getDocumentsProjectsRoot();
      await fs.mkdir(parent, { recursive: true });
      const projectFolder = path.join(parent, trimmedName);
      try {
        await fs.access(projectFolder);
        throw new Error(`A project folder named "${trimmedName}" already exists at ${parent}.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(projectFolder, { recursive: true });
      const simularcaPath = pointerFilePath(projectFolder, trimmedName);
      const pointer = createPointer();
      await writePointer(simularcaPath, pointer);
      await ensureProjectFolderStructure(simularcaPath);
      await fs.writeFile(snapshotFileForPath(simularcaPath, "main"), args.initialSnapshotPayload, "utf8");
      const identity: ProjectIdentity = { uuid: pointer.uuid, path: simularcaPath, name: trimmedName };
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "project:open",
    async (_event, args: { simularcaPath: string }): Promise<OpenProjectResult> => {
      const pointer = await readPointer(args.simularcaPath);
      let identity: ProjectIdentity = {
        uuid: pointer.uuid,
        path: args.simularcaPath,
        name: projectNameFromSimularcaPath(args.simularcaPath)
      };

      // Collision detection: if another open project shares this uuid at a different
      // path, the user must have duplicated the folder by hand. Re-issue a new uuid
      // into the just-opened pointer so the two projects diverge.
      const existingPath = openProjectFoldersByUuid.get(pointer.uuid);
      if (existingPath && path.resolve(existingPath) !== path.resolve(projectFolderForPath(args.simularcaPath))) {
        const fresh = createPointer();
        await writePointer(args.simularcaPath, fresh);
        identity = { ...identity, uuid: fresh.uuid };
        void writeRuntimeLog(
          "project:open",
          "UUID collision detected; reissued new uuid",
          { previousUuid: pointer.uuid, newUuid: fresh.uuid, path: args.simularcaPath },
          "warn"
        );
      }

      await ensureProjectFolderStructure(args.simularcaPath);
      rememberProjectFolder(identity);

      const snapshotsDir = snapshotsDirForPath(args.simularcaPath);
      const entries = await fs.readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
      const snapshotFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => ({
          name: entry.name.replace(/\.json$/i, ""),
          filePath: path.join(snapshotsDir, entry.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const snapshots = await Promise.all(
        snapshotFiles.map(async (entry) => ({
          name: entry.name,
          updatedAtIso: await readSnapshotUpdatedAtIso(entry.filePath)
        }))
      );

      const recents = await loadRecents(getRecentsFilePath());
      const previousRecent = findRecentByUuid(recents, identity.uuid);
      return {
        identity,
        snapshots: snapshots.length === 0 ? [{ name: "main", updatedAtIso: null }] : snapshots,
        lastSnapshotName: previousRecent?.lastSnapshotName ?? null
      };
    }
  );

  ipcMain.handle(
    "project:save-snapshot",
    async (
      _event,
      args: { projectPath: string; snapshotName: string; payload: string }
    ): Promise<void> => {
      await ensureProjectFolderStructure(args.projectPath);
      await fs.writeFile(snapshotFileForPath(args.projectPath, args.snapshotName), args.payload, "utf8");
    }
  );

  ipcMain.handle(
    "snapshot:load",
    async (_event, args: { projectPath: string; snapshotName: string }): Promise<string> => {
      await ensureProjectFolderStructure(args.projectPath);
      const file = snapshotFileForPath(args.projectPath, args.snapshotName);
      try {
        await fs.access(file);
        return await fs.readFile(file, "utf8");
      } catch {
        await fs.writeFile(file, "{}", "utf8");
        return "{}";
      }
    }
  );

  ipcMain.handle(
    "snapshots:list",
    async (_event, args: { projectPath: string }): Promise<ProjectSnapshotListEntry[]> => {
      await ensureProjectFolderStructure(args.projectPath);
      const dir = snapshotsDirForPath(args.projectPath);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const snapshotFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => ({
          name: entry.name.replace(/\.json$/i, ""),
          filePath: path.join(dir, entry.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const snapshots = await Promise.all(
        snapshotFiles.map(async (entry) => ({
          name: entry.name,
          updatedAtIso: await readSnapshotUpdatedAtIso(entry.filePath)
        }))
      );
      if (snapshots.length === 0) {
        return [{ name: "main", updatedAtIso: null }];
      }
      return snapshots;
    }
  );

  ipcMain.handle(
    "snapshot:duplicate",
    async (
      _event,
      args: { projectPath: string; previousName: string; nextName: string }
    ): Promise<void> => {
      await ensureProjectFolderStructure(args.projectPath);
      await fs.copyFile(
        snapshotFileForPath(args.projectPath, args.previousName),
        snapshotFileForPath(args.projectPath, args.nextName)
      );
    }
  );

  ipcMain.handle(
    "snapshot:rename",
    async (
      _event,
      args: { projectPath: string; previousName: string; nextName: string }
    ): Promise<void> => {
      await ensureProjectFolderStructure(args.projectPath);
      await fs.rename(
        snapshotFileForPath(args.projectPath, args.previousName),
        snapshotFileForPath(args.projectPath, args.nextName)
      );
    }
  );

  ipcMain.handle(
    "snapshot:delete",
    async (_event, args: { projectPath: string; snapshotName: string }): Promise<void> => {
      await ensureProjectFolderStructure(args.projectPath);
      await fs.rm(snapshotFileForPath(args.projectPath, args.snapshotName), { force: true });
    }
  );

  ipcMain.handle(
    "project:save-as",
    async (
      _event,
      args: { currentPath: string; newParentFolder: string; newProjectName: string }
    ): Promise<ProjectIdentity> => {
      const trimmed = args.newProjectName.trim();
      if (!trimmed) {
        throw new Error("Project name is required.");
      }
      const sourceFolder = projectFolderForPath(args.currentPath);
      const destFolder = path.join(args.newParentFolder, trimmed);
      try {
        await fs.access(destFolder);
        throw new Error(`A project folder named "${trimmed}" already exists at ${args.newParentFolder}.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(args.newParentFolder, { recursive: true });
      try {
        await copyDirectoryRecursive(sourceFolder, destFolder);
      } catch (error) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      // Verify file count parity before swapping in the new pointer.
      const srcCount = await readFolderEntryCount(sourceFolder);
      const dstCount = await readFolderEntryCount(destFolder);
      if (srcCount !== dstCount) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(
          `Save As verification failed: source had ${srcCount} files but destination has ${dstCount}.`
        );
      }
      // Drop any pointer files copied from the source and write a fresh one.
      const copiedPointers = await discoverAllSimularcaFiles(destFolder);
      for (const p of copiedPointers) {
        await fs.rm(p, { force: true });
      }
      const newPointerPath = pointerFilePath(destFolder, trimmed);
      const fresh = createPointer();
      await writePointer(newPointerPath, fresh);
      const identity: ProjectIdentity = { uuid: fresh.uuid, path: newPointerPath, name: trimmed };
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "project:move",
    async (_event, args: { currentPath: string; newParentFolder: string }): Promise<ProjectIdentity> => {
      const pointer = await readPointer(args.currentPath);
      const sourceFolder = projectFolderForPath(args.currentPath);
      const folderName = path.basename(sourceFolder);
      const destFolder = path.join(args.newParentFolder, folderName);
      if (path.resolve(sourceFolder) === path.resolve(destFolder)) {
        return {
          uuid: pointer.uuid,
          path: args.currentPath,
          name: projectNameFromSimularcaPath(args.currentPath)
        };
      }
      try {
        await fs.access(destFolder);
        throw new Error(`A folder named "${folderName}" already exists at ${args.newParentFolder}.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(args.newParentFolder, { recursive: true });
      try {
        await copyDirectoryRecursive(sourceFolder, destFolder);
      } catch (error) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const srcCount = await readFolderEntryCount(sourceFolder);
      const dstCount = await readFolderEntryCount(destFolder);
      if (srcCount !== dstCount) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(
          `Move verification failed: source had ${srcCount} files but destination has ${dstCount}.`
        );
      }
      // Source verified copied; remove original.
      try {
        await fs.rm(sourceFolder, { recursive: true, force: true });
      } catch (error) {
        void writeRuntimeLog(
          "project:move",
          "Failed to remove source folder after move; destination is intact",
          { sourceFolder, destFolder, error },
          "warn"
        );
      }
      const newPath = path.join(destFolder, path.basename(args.currentPath));
      const identity: ProjectIdentity = {
        uuid: pointer.uuid,
        path: newPath,
        name: projectNameFromSimularcaPath(newPath)
      };
      forgetProjectFolder(pointer.uuid);
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "project:rename",
    async (_event, args: { currentPath: string; newProjectName: string }): Promise<ProjectIdentity> => {
      const trimmed = args.newProjectName.trim();
      if (!trimmed) {
        throw new Error("Project name is required.");
      }
      const pointer = await readPointer(args.currentPath);
      const sourceFolder = projectFolderForPath(args.currentPath);
      const parent = path.dirname(sourceFolder);
      const oldName = path.basename(args.currentPath, SIMULARCA_EXTENSION);
      if (oldName === trimmed) {
        return {
          uuid: pointer.uuid,
          path: args.currentPath,
          name: oldName
        };
      }
      const newPointerPath = pointerFilePath(sourceFolder, trimmed);
      try {
        await fs.access(newPointerPath);
        throw new Error(`A file named "${trimmed}${SIMULARCA_EXTENSION}" already exists in this folder.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      // Rename the pointer file.
      await fs.rename(args.currentPath, newPointerPath);

      // Rename the containing folder when its basename matches the old project name.
      let finalFolder = sourceFolder;
      if (path.basename(sourceFolder) === oldName) {
        const newFolder = path.join(parent, trimmed);
        const sameCaseInsensitive =
          sourceFolder !== newFolder && sourceFolder.toLowerCase() === newFolder.toLowerCase();
        try {
          if (sameCaseInsensitive) {
            // Two-step rename for case-only changes on case-insensitive filesystems.
            const tempFolder = path.join(parent, `${oldName}.__rename__${Date.now()}`);
            await fs.rename(sourceFolder, tempFolder);
            await fs.rename(tempFolder, newFolder);
          } else {
            await fs.rename(sourceFolder, newFolder);
          }
          finalFolder = newFolder;
        } catch (error) {
          void writeRuntimeLog(
            "project:rename",
            "Pointer renamed but folder rename failed; project still works",
            { sourceFolder, newFolder, error },
            "warn"
          );
        }
      }

      const finalPointerPath = pointerFilePath(finalFolder, trimmed);
      const identity: ProjectIdentity = { uuid: pointer.uuid, path: finalPointerPath, name: trimmed };
      forgetProjectFolder(pointer.uuid);
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "project:delete",
    async (_event, args: { projectPath: string }): Promise<void> => {
      let uuid: string | null = null;
      try {
        const pointer = await readPointer(args.projectPath);
        uuid = pointer.uuid;
      } catch {
        // Pointer might be corrupt; still attempt folder removal.
      }
      const folder = projectFolderForPath(args.projectPath);
      await fs.rm(folder, { recursive: true, force: true });
      if (uuid) {
        forgetProjectFolder(uuid);
        const recents = await loadRecents(getRecentsFilePath());
        await saveRecents(getRecentsFilePath(), removeRecentByUuid(recents, uuid));
        const defaults = await loadDefaultsFromUserData();
        if (defaults && defaults.uuid === uuid) {
          await saveDefaultsToUserData(null);
        }
      }
    }
  );

  ipcMain.handle(
    "project:repair-pointer",
    async (_event, args: { folderPath: string }): Promise<ProjectIdentity> => {
      const identity = await repairPointer(args.folderPath);
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "asset:import",
    async (
      _event,
      args: {
        projectPath: string;
        sourcePath: string;
        kind: ProjectAssetRef["kind"];
      }
    ) => {
      await ensureProjectFolderStructure(args.projectPath);
      const sourceFileName = path.basename(args.sourcePath);
      const extension = path.extname(sourceFileName);
      const targetName = `${Date.now()}-${randomUUID()}${extension}`;
      const assetDirectory = assetsDirForPath(args.projectPath, args.kind);
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetPath = path.join(assetDirectory, targetName);
      await fs.copyFile(args.sourcePath, targetPath);
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(projectFolderForPath(args.projectPath), targetPath).replaceAll("\\", "/");

      const assetRef: ProjectAssetRef = {
        id: randomUUID(),
        kind: args.kind,
        encoding: "raw",
        relativePath,
        sourceFileName,
        byteSize: stat.size
      };
      return assetRef;
    }
  );

  ipcMain.handle(
    "asset:write-generated",
    async (
      _event,
      args: {
        projectPath: string;
        bytes: Uint8Array;
        fileName: string;
        kind: ProjectAssetRef["kind"];
      }
    ) => {
      await ensureProjectFolderStructure(args.projectPath);
      const sourceFileName = args.fileName;
      const extension = path.extname(sourceFileName) || ".bin";
      const targetName = `${Date.now()}-${randomUUID()}${extension}`;
      const assetDirectory = assetsDirForPath(args.projectPath, args.kind);
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetPath = path.join(assetDirectory, targetName);
      await fs.writeFile(targetPath, Buffer.from(args.bytes));
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(projectFolderForPath(args.projectPath), targetPath).replaceAll("\\", "/");

      const assetRef: ProjectAssetRef = {
        id: randomUUID(),
        kind: args.kind,
        encoding: "raw",
        relativePath,
        sourceFileName,
        byteSize: stat.size
      };
      return assetRef;
    }
  );

  ipcMain.handle(
    "asset:import-dae",
    async (
      _event,
      args: {
        projectPath: string;
        sourcePath: string;
      }
    ): Promise<DaeImportResult> => {
      await ensureProjectFolderStructure(args.projectPath);

      // 1. Read the .dae source (needed for both XML patching and image extraction)
      const sourceFileName = path.basename(args.sourcePath);
      const extension = path.extname(sourceFileName);
      const daeTargetName = `${Date.now()}-${randomUUID()}${extension}`;
      const genericDir = assetsDirForPath(args.projectPath, "generic");
      await fs.mkdir(genericDir, { recursive: true });
      const daeTargetPath = path.join(genericDir, daeTargetName);
      // Read source text first; we will patch and write it rather than copying
      const daeSourceText = await fs.readFile(args.sourcePath, "utf8");
      const daeRelPath = path.relative(projectFolderForPath(args.projectPath), daeTargetPath).replaceAll("\\", "/");
      // daeAsset is built after patching and writing so byteSize reflects the written file

      // 2. Parse DAE XML for texture references and material definitions
      const daeText = daeSourceText;
      const sourceDir = path.dirname(args.sourcePath);
      const imageDir = assetsDirForPath(args.projectPath, "image");
      await fs.mkdir(imageDir, { recursive: true });

      // Extract image paths from <init_from> elements
      const initFromMatches = [...daeText.matchAll(/<init_from>\s*([^<]+?)\s*<\/init_from>/g)];
      const imageAssets: ProjectAssetRef[] = [];
      const imageIdBySourceName = new Map<string, string>(); // source filename -> asset id
      const imgTargetNameBySourceName = new Map<string, string>(); // source filename -> target filename (for path rewriting)

      for (const match of initFromMatches) {
        const rawRef = (match[1] ?? "").trim();
        // Strip file:// prefix and URL-decode
        const decoded = decodeURIComponent(rawRef.replace(/^file:\/\/\//i, ""));
        const imgPath = path.isAbsolute(decoded) ? decoded : path.join(sourceDir, decoded);
        const imgName = path.basename(imgPath);
        if (imageIdBySourceName.has(imgName)) continue;
        try {
          await fs.access(imgPath);
          const imgTargetName = `${Date.now()}-${randomUUID()}${path.extname(imgName)}`;
          const imgTargetPath = path.join(imageDir, imgTargetName);
          await fs.copyFile(imgPath, imgTargetPath);
          const imgStat = await fs.stat(imgTargetPath);
          const imgRelPath = path.relative(projectFolderForPath(args.projectPath), imgTargetPath).replaceAll("\\", "/");
          const imgAsset: ProjectAssetRef = {
            id: randomUUID(),
            kind: "image",
            encoding: "raw",
            relativePath: imgRelPath,
            sourceFileName: imgName,
            byteSize: imgStat.size
          };
          imageAssets.push(imgAsset);
          imageIdBySourceName.set(imgName, imgAsset.id);
          imgTargetNameBySourceName.set(imgName, imgTargetName);
        } catch {
          // File not accessible; skip
        }
      }

      // Rewrite <init_from> paths in the DAE XML so ColladaLoader can resolve textures via the
      // simularca-asset:// protocol. The DAE is stored in assets/generic/, images in assets/image/,
      // so the relative path from the DAE to each image is ../image/<targetName>.
      let patchedDaeText = daeText;
      for (const match of initFromMatches) {
        const rawRef = (match[1] ?? "").trim();
        const decoded = decodeURIComponent(rawRef.replace(/^file:\/\/\//i, ""));
        const imgName = path.basename(decoded);
        const newFileName = imgTargetNameBySourceName.get(imgName);
        if (newFileName) {
          // Use split/join to replace all occurrences of this exact match text safely
          patchedDaeText = patchedDaeText.split(match[0]).join(`<init_from>../image/${newFileName}</init_from>`);
        }
      }
      await fs.writeFile(daeTargetPath, patchedDaeText, "utf8");
      const daeStat = await fs.stat(daeTargetPath);
      const daeAsset: ProjectAssetRef = {
        id: randomUUID(),
        kind: "generic",
        encoding: "raw",
        relativePath: daeRelPath,
        sourceFileName,
        byteSize: daeStat.size
      };

      // 3. Extract image ID mapping from <library_images>: DAE image id -> asset id
      const daeImageIdToAssetId = new Map<string, string>();
      const imageElems = [...daeText.matchAll(/<image\s+id="([^"]+)"[^>]*>[\s\S]*?<init_from>\s*([^<]+?)\s*<\/init_from>/g)];
      for (const m of imageElems) {
        const daeImgId = m[1] ?? "";
        const rawRef = (m[2] ?? "").trim();
        const decoded = decodeURIComponent(rawRef.replace(/^file:\/\/\//i, ""));
        const imgName = path.basename(decoded);
        const assetId = imageIdBySourceName.get(imgName);
        if (assetId) daeImageIdToAssetId.set(daeImgId, assetId);
      }

      // 4. Map effect texture sampler -> image id
      const samplerToImageId = new Map<string, string>();
      const samplerMatches = [...daeText.matchAll(/<newparam\s+sid="([^"]+)"[\s\S]*?<surface[\s\S]*?<init_from>\s*([^<\s]+)\s*<\/init_from>/g)];
      for (const m of samplerMatches) {
        const sid = m[1] ?? "";
        const imgId = (m[2] ?? "").trim();
        const assetId = daeImageIdToAssetId.get(imgId);
        if (assetId) samplerToImageId.set(sid, assetId);
      }

      // 5. Parse library_effects to get per-effect channel data
      const effectById = new Map<string, {
        albedo: { mode: "color"; color: string } | { mode: "image"; assetId: string };
        roughness: number;
        metalness: number;
        normalMapAssetId: string | null;
        emissive: string;
      }>();

      const effectMatches = [...daeText.matchAll(/<effect\s+id="([^"]+)"[\s\S]*?(?=<effect\s+id=|<\/library_effects>)/g)];
      for (const em of effectMatches) {
        const effectId = em[1] ?? "";
        const effectBody = em[0];

        // Diffuse color or texture
        let albedo: { mode: "color"; color: string } | { mode: "image"; assetId: string } = { mode: "color", color: "#ffffff" };
        const diffuseTexMatch = effectBody.match(/<diffuse>[\s\S]*?<texture\s+texture="([^"]+)"/);
        if (diffuseTexMatch) {
          const samplerRef = diffuseTexMatch[1] ?? "";
          const assetId = samplerToImageId.get(samplerRef);
          if (assetId) albedo = { mode: "image", assetId };
        } else {
          const diffuseColorMatch = effectBody.match(/<diffuse>[\s\S]*?<color[^>]*>\s*([\d.\s-]+)\s*<\/color>/);
          if (diffuseColorMatch) {
            const parts = (diffuseColorMatch[1] ?? "").trim().split(/\s+/).map(Number);
            const r = Math.round((parts[0] ?? 1) * 255).toString(16).padStart(2, "0");
            const g = Math.round((parts[1] ?? 1) * 255).toString(16).padStart(2, "0");
            const b = Math.round((parts[2] ?? 1) * 255).toString(16).padStart(2, "0");
            albedo = { mode: "color", color: `#${r}${g}${b}` };
          }
        }

        // Emissive color
        let emissive = "#000000";
        const emissiveColorMatch = effectBody.match(/<emission>[\s\S]*?<color[^>]*>\s*([\d.\s-]+)\s*<\/color>/);
        if (emissiveColorMatch) {
          const parts = (emissiveColorMatch[1] ?? "").trim().split(/\s+/).map(Number);
          const r = Math.round(Math.min(1, parts[0] ?? 0) * 255).toString(16).padStart(2, "0");
          const g = Math.round(Math.min(1, parts[1] ?? 0) * 255).toString(16).padStart(2, "0");
          const b = Math.round(Math.min(1, parts[2] ?? 0) * 255).toString(16).padStart(2, "0");
          emissive = `#${r}${g}${b}`;
        }

        // Shininess → roughness heuristic
        let roughness = 0.5;
        const shinyMatch = effectBody.match(/<shininess>[\s\S]*?<float[^>]*>\s*([\d.]+)\s*<\/float>/);
        if (shinyMatch) {
          const shininess = Math.max(0, parseFloat(shinyMatch[1] ?? "0"));
          roughness = Math.max(0, Math.min(1, 1 - Math.sqrt(shininess / 128)));
        }

        effectById.set(effectId, { albedo, roughness, metalness: 0, normalMapAssetId: null, emissive });
      }

      // 6. Map material id -> { display name, effect id }
      // Three.js ColladaLoader names materials using the DAE <material name="..."> attribute,
      // so we key slots by that to match what the renderer will see.
      const materialEffectMap = new Map<string, { name: string; effectId: string }>();
      const matEffectMatches = [...daeText.matchAll(/<material\s+id="([^"]+)"([^>]*)>[\s\S]*?<instance_effect\s+url="#([^"]+)"/g)];
      for (const m of matEffectMatches) {
        const daeId = m[1] ?? "";
        const attrs = m[2] ?? "";
        const nameMatch = attrs.match(/\bname="([^"]*)"/);
        const matName = nameMatch?.[1]?.trim() || daeId;
        const effectId = m[3] ?? "";
        materialEffectMap.set(daeId, { name: matName, effectId });
      }

      // 7. Build material definitions and slot mapping
      const materialDefs: DaeImportResult["materialDefs"] = [];
      const materialSlots: Record<string, string> = {};

      for (const { name: matName, effectId } of materialEffectMap.values()) {
        const effect = effectById.get(effectId);
        const matId = `mat.${randomUUID()}`;
        materialDefs.push({
          id: matId,
          name: matName,
          albedo: effect?.albedo ?? { mode: "color", color: "#ffffff" },
          roughness: effect?.roughness ?? 0.5,
          metalness: effect?.metalness ?? 0,
          normalMapAssetId: effect?.normalMapAssetId ?? null,
          emissive: effect?.emissive ?? "#000000"
        });
        materialSlots[matName] = matId;
      }

      return { asset: daeAsset, imageAssets, materialDefs, materialSlots };
    }
  );

  ipcMain.handle(
    "asset:transcode-hdri",
    async (
      _event,
      args: {
        projectPath: string;
        sourcePath: string;
        options?: HdriTranscodeOptions;
      }
    ) => {
      await ensureProjectFolderStructure(args.projectPath);
      const assetDirectory = assetsDirForPath(args.projectPath, "hdri");
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetName = `${Date.now()}-${randomUUID()}.ktx2`;
      const targetPath = path.join(assetDirectory, targetName);
      await runToktx({
        inputPath: args.sourcePath,
        outputPath: targetPath,
        options: args.options
      });
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(projectFolderForPath(args.projectPath), targetPath).replaceAll("\\", "/");
      const sourceFileName = path.basename(args.sourcePath);
      const assetRef: ProjectAssetRef = {
        id: randomUUID(),
        kind: "hdri",
        encoding: "ktx2",
        relativePath,
        sourceFileName,
        byteSize: stat.size
      };
      return assetRef;
    }
  );

  ipcMain.handle(
    "asset:delete",
    async (
      _event,
      args: {
        projectPath: string;
        relativePath: string;
      }
    ) => {
      const absolute = path.resolve(projectFolderForPath(args.projectPath), args.relativePath);
      await fs.rm(absolute, { force: true });
    }
  );

  ipcMain.handle(
    "asset:resolve-path",
    async (
      _event,
      args: {
        projectUuid: string;
        relativePath: string;
      }
    ) => {
      const encodedUuid = encodeURIComponent(args.projectUuid);
      const encodedPath = args.relativePath
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
      return `${ASSET_PROTOCOL}://${encodedUuid}/${encodedPath}`;
    }
  );

  ipcMain.handle(
    "asset:read-bytes",
    async (
      _event,
      args: {
        projectPath: string;
        relativePath: string;
      }
    ) => {
      const projectRoot = path.resolve(projectFolderForPath(args.projectPath));
      const absolutePath = path.resolve(projectRoot, args.relativePath);
      if (!absolutePath.startsWith(projectRoot)) {
        throw new Error("Invalid asset path");
      }
      const bytes = await fs.readFile(absolutePath);
      return Uint8Array.from(bytes);
    }
  );

  ipcMain.handle(
    "projection-cache:read",
    async (_event, args: { projectPath: string }): Promise<ProjectionCacheFileV1 | null> => {
      const file = path.join(projectFolderForPath(args.projectPath), "cache", "projection-cache.json");
      try {
        const text = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(text) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { version?: unknown }).version === 1 &&
          (parsed as { entries?: unknown }).entries &&
          typeof (parsed as { entries?: unknown }).entries === "object"
        ) {
          return parsed as ProjectionCacheFileV1;
        }
        return null;
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle(
    "projection-cache:write",
    async (
      _event,
      args: { projectPath: string; payload: ProjectionCacheFileV1 }
    ): Promise<void> => {
      const cacheDir = path.join(projectFolderForPath(args.projectPath), "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const target = path.join(cacheDir, "projection-cache.json");
      const tmp = `${target}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(args.payload), "utf8");
      await fs.rename(tmp, target);
    }
  );

  // Migration handlers (legacy savedata → user-chosen project locations).
  ipcMain.handle(
    "migration:detect-legacy",
    async (): Promise<LegacyProjectInfo[]> => {
      const root = getLegacySaveDataRoot();
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const projects: LegacyProjectInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(root, entry.name);
        // Skip if the folder has already been migrated (has a .simularca pointer).
        const existing = await discoverSimularcaFile(folder);
        if (existing) continue;
        const snapshotsDir = path.join(folder, SNAPSHOTS_DIR);
        let snapshotCount = 0;
        try {
          const snapEntries = await fs.readdir(snapshotsDir, { withFileTypes: true });
          snapshotCount = snapEntries.filter(
            (e) => e.isFile() && e.name.toLowerCase().endsWith(".json")
          ).length;
        } catch {
          // No snapshots dir; check for legacy session.json.
          try {
            await fs.access(path.join(folder, "session.json"));
            snapshotCount = 1;
          } catch {
            // No project content; skip.
            continue;
          }
        }
        const totalBytes = await readFolderTotalBytes(folder);
        projects.push({ legacyName: entry.name, snapshotCount, totalBytes });
      }
      return projects.sort((a, b) => a.legacyName.localeCompare(b.legacyName));
    }
  );

  ipcMain.handle(
    "migration:run",
    async (
      _event,
      args: { legacyName: string; targetParentFolder: string }
    ): Promise<ProjectIdentity> => {
      const sourceFolder = getLegacyProjectDirectory(args.legacyName);
      const trimmedName = args.legacyName.trim();
      await fs.mkdir(args.targetParentFolder, { recursive: true });
      const destFolder = path.join(args.targetParentFolder, trimmedName);
      try {
        await fs.access(destFolder);
        throw new Error(
          `A folder named "${trimmedName}" already exists at ${args.targetParentFolder}.`
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      try {
        await copyDirectoryRecursive(sourceFolder, destFolder);
      } catch (error) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const srcCount = await readFolderEntryCount(sourceFolder);
      const dstCount = await readFolderEntryCount(destFolder);
      if (srcCount !== dstCount) {
        await fs.rm(destFolder, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(
          `Migration verification failed: source had ${srcCount} files but destination has ${dstCount}.`
        );
      }
      // Migrate legacy session.json → snapshots/main.json if needed.
      const legacySession = path.join(destFolder, "session.json");
      const snapshotsDir = path.join(destFolder, SNAPSHOTS_DIR);
      await fs.mkdir(snapshotsDir, { recursive: true });
      try {
        await fs.access(legacySession);
        const mainSnapshot = path.join(snapshotsDir, "main.json");
        try {
          await fs.access(mainSnapshot);
          // main.json already exists; legacy session.json is redundant.
        } catch {
          await fs.copyFile(legacySession, mainSnapshot);
        }
        await fs.rm(legacySession, { force: true });
      } catch {
        // No legacy session.json.
      }
      const pointerPath = pointerFilePath(destFolder, trimmedName);
      const pointer = createPointer();
      await writePointer(pointerPath, pointer);
      // Verified copy + pointer written; remove original.
      await fs.rm(sourceFolder, { recursive: true, force: true }).catch((error) => {
        void writeRuntimeLog(
          "migration:run",
          "Failed to remove source folder after successful migration",
          { sourceFolder, error },
          "warn"
        );
      });
      const identity: ProjectIdentity = {
        uuid: pointer.uuid,
        path: pointerPath,
        name: trimmedName
      };
      rememberProjectFolder(identity);
      return identity;
    }
  );

  ipcMain.handle(
    "migration:write-readme",
    async (
      _event,
      args: { failedProjectNames: string[]; skippedProjectNames: string[] }
    ): Promise<void> => {
      const root = getLegacySaveDataRoot();
      try {
        await fs.access(root);
      } catch {
        return;
      }
      const lines: string[] = [
        "Simularca — your project storage has moved",
        "",
        "Projects are no longer stored under this folder. Pick any location you like",
        "(including cloud-synced folders) and use \"Open Project…\" or \"New Project…\"",
        "from the app's title bar to get started.",
        "",
        "App-internal state now lives in:",
        "  Windows:  %APPDATA%/Simularca/",
        "  macOS:    ~/Library/Application Support/Simularca/",
        "  Linux:    ~/.config/Simularca/",
        ""
      ];
      if (args.failedProjectNames.length > 0) {
        lines.push("Projects that failed to migrate (still in this folder):");
        for (const name of args.failedProjectNames) {
          lines.push(`  - ${name}`);
        }
        lines.push("");
      }
      if (args.skippedProjectNames.length > 0) {
        lines.push("Projects you skipped during migration (still in this folder):");
        for (const name of args.skippedProjectNames) {
          lines.push(`  - ${name}`);
        }
        lines.push("");
      }
      lines.push("You can re-run the migration any time by relaunching Simularca.");
      lines.push("");
      await fs.writeFile(path.join(root, "README.txt"), lines.join("\n"), "utf8");
    }
  );

  ipcMain.handle(
    "migration:delete-legacy",
    async (_event, args: { legacyName: string }): Promise<void> => {
      const folder = getLegacyProjectDirectory(args.legacyName);
      await fs.rm(folder, { recursive: true, force: true });
    }
  );

  registerPublishIpcHandlers();
}

// ----------------------------------------------------------------------
// Publish-to-web IPC handlers
// ----------------------------------------------------------------------

function getPublishSettingsFilePath(): string {
  return path.join(getUserDataRoot(), PUBLISH_SETTINGS_FILE_NAME);
}

interface VercelTokenVerifyResult {
  ok: boolean;
  email?: string;
  username?: string;
  userId?: string;
  teamSlug?: string;
  error?: string;
}

interface VercelSettingsWriteRequest {
  /** New token to set; if empty/absent only the metadata fields are patched. */
  token?: string;
  /** Pass true to wipe credentials entirely (logout). */
  clear?: boolean;
  projectName?: string;
  projectId?: string;
  teamId?: string;
}

interface DeployViewerProgressIpcEvent {
  jobId: string;
  phase: "build" | "project" | "deploy" | "ready" | "done" | "error";
  message?: string;
  uploadedFiles?: number;
  totalFiles?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  url?: string;
  error?: string;
}

async function runViewerBuild(args: {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const repoRoot = getRepoRoot();
    const scriptPath = path.join(repoRoot, "scripts", "build-viewer.mjs");
    const writeInfoPath = path.join(repoRoot, "scripts", "write-build-info.mjs");
    // Run write-build-info then build-viewer in sequence as a small wrapper.
    // Using `process.execPath` with `ELECTRON_RUN_AS_NODE=1` makes Electron's
    // bundled node available even on packaged builds.
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const writeInfo = spawn(process.execPath, [writeInfoPath, "build"], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    writeInfo.stdout.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) args.onStdout?.(line);
      }
    });
    writeInfo.stderr.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) args.onStderr?.(line);
      }
    });
    writeInfo.on("error", reject);
    writeInfo.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`write-build-info exited ${String(code)}`));
        return;
      }
      const child = spawn(process.execPath, [scriptPath], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const cleanup = (): void => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      };
      args.signal?.addEventListener("abort", cleanup, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) args.onStdout?.(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) args.onStderr?.(line);
        }
      });
      child.on("error", (error) => {
        args.signal?.removeEventListener("abort", cleanup);
        reject(error);
      });
      child.on("exit", (code) => {
        args.signal?.removeEventListener("abort", cleanup);
        if (code === 0) resolve();
        else reject(new Error(`build-viewer exited ${String(code)}`));
      });
    });
  });
}

interface BuildInfoFile {
  version?: string;
  commitShortSha?: string;
}

function loadEditorBuildInfo(): { version: string; commitShortSha: string } {
  try {
    const raw = fsSync.readFileSync(path.join(getRepoRoot(), ".simularca-build-info.json"), "utf8");
    const parsed = JSON.parse(raw) as BuildInfoFile;
    return {
      version: parsed.version ?? app.getVersion() ?? "0.0.0",
      commitShortSha: parsed.commitShortSha ?? "dev"
    };
  } catch {
    return { version: app.getVersion() ?? "0.0.0", commitShortSha: "dev" };
  }
}

const inFlightPublishJobs = new Map<string, AbortController>();

function encryptVercelTokenIfPresent(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Cannot store Vercel token: OS keychain is unavailable to safeStorage.");
  }
  return safeStorage.encryptString(token).toString("base64");
}

function decryptVercelToken(encryptedBase64: string | undefined): string | null {
  if (!encryptedBase64) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encryptedBase64, "base64"));
  } catch {
    return null;
  }
}

function applyTargetWriteRequest(
  existing: PublishTarget | null,
  request: PublishTargetWriteRequest
): PublishTarget {
  const secrets = request.secrets ?? {};
  const r2SecretAccessKey =
    secrets.r2SecretAccessKey !== undefined ? secrets.r2SecretAccessKey : existing?.r2.secretAccessKey ?? "";
  const vercelTokenEncryptedBase64 =
    secrets.vercelToken !== undefined
      ? encryptVercelTokenIfPresent(secrets.vercelToken)
      : existing?.selfHosted?.vercelTokenEncryptedBase64;
  const selfHosted =
    request.selfHosted || vercelTokenEncryptedBase64
      ? {
          vercelTokenEncryptedBase64,
          vercelProjectId: request.selfHosted?.vercelProjectId,
          vercelTeamId: request.selfHosted?.vercelTeamId
        }
      : undefined;
  return {
    id: request.id,
    label: request.label,
    r2: {
      accountId: request.r2.accountId,
      accessKeyId: request.r2.accessKeyId,
      secretAccessKey: r2SecretAccessKey,
      bucket: request.r2.bucket,
      region: request.r2.region
    },
    bucketBaseUrl: request.bucketBaseUrl,
    viewerUrl: request.viewerUrl,
    selfHosted,
    manifestRetention: request.manifestRetention
  };
}

function discoverInstalledPlugins(): DiscoveredPluginEntry[] {
  const seen = new Set<string>();
  const out: DiscoveredPluginEntry[] = [];
  const roots = [
    path.join(getRepoRoot(), "plugins-external"),
    path.join(getRepoRoot(), "plugins")
  ];
  for (const root of roots) {
    if (!fsSync.existsSync(root)) continue;
    for (const entry of fsSync.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginRoot = path.join(root, entry.name);
      const pkgPath = path.join(pluginRoot, "package.json");
      if (!fsSync.existsSync(pkgPath)) continue;
      let pkg: { name?: string; version?: string } = {};
      try {
        pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      } catch {
        continue;
      }
      const id = pkg.name ?? entry.name;
      if (seen.has(id)) continue;
      let entryPath: string;
      try {
        entryPath = resolvePluginEntry(pluginRoot);
      } catch {
        continue;
      }
      if (!fsSync.existsSync(entryPath)) {
        // Plugin source exists but hasn't been built. Skip with a log;
        // pre-flight can surface this to the user.
        void writeRuntimeLog(
          "publish",
          "plugin not built; skipping",
          { id, entryPath },
          "warn"
        );
        continue;
      }
      seen.add(id);
      out.push({ id, entryPath, version: pkg.version ?? "0.0.0" });
    }
  }
  return out;
}

function registerPublishIpcHandlers(): void {
  ipcMain.handle("publish:load-settings", async (): Promise<RedactedPublishSettings> => {
    const settings = await loadPublishSettings(getPublishSettingsFilePath());
    return redactSettings(settings);
  });

  ipcMain.handle(
    "publish:save-settings",
    async (
      _event,
      args: { targets: PublishTargetWriteRequest[]; defaultTargetId?: string }
    ): Promise<RedactedPublishSettings> => {
      const existing = await loadPublishSettings(getPublishSettingsFilePath());
      const existingById = new Map(existing.targets.map((target) => [target.id, target]));
      const nextTargets: PublishTarget[] = args.targets.map((request) =>
        applyTargetWriteRequest(existingById.get(request.id) ?? null, request)
      );
      const next: PublishSettings = {
        ...existing,
        targets: nextTargets,
        defaultTargetId: args.defaultTargetId
      };
      await savePublishSettings(getPublishSettingsFilePath(), next);
      return redactSettings(next);
    }
  );

  ipcMain.handle(
    "publish:list-for-project",
    async (_event, args: { projectUuid: string }): Promise<ListedPublish[]> => {
      const settings = await loadPublishSettings(getPublishSettingsFilePath());
      return settings.publishesByProjectUuid[args.projectUuid] ?? [];
    }
  );

  ipcMain.handle(
    "publish:check-viewer-version",
    async (
      _event,
      args: PublishCheckViewerVersionRequest
    ): Promise<PublishCheckViewerVersionResult> => {
      const settings = await loadPublishSettings(getPublishSettingsFilePath());
      const target = findTarget(settings, args.targetId);
      if (!target) {
        return { deployed: false, error: `Publish target not found: ${args.targetId}` };
      }
      return await checkViewerVersionRemote(
        { viewerUrl: target.viewerUrl, sha: args.sha },
        { maxRetries: args.maxRetries, retryDelayMs: args.retryDelayMs }
      );
    }
  );

  ipcMain.handle(
    "publish:verify-target",
    async (
      _event,
      args: { draft: PublishTargetWriteRequest; skipNetwork?: boolean }
    ): Promise<VerifyTargetResult> => {
      // Resolve the secret: if the renderer didn't supply a fresh one, fall
      // back to the saved value for the existing target so we can run the live
      // probe against whatever is currently on disk.
      const existing = (await loadPublishSettings(getPublishSettingsFilePath())).targets.find(
        (target) => target.id === args.draft.id
      );
      const secrets = args.draft.secrets ?? {};
      const r2SecretAccessKey =
        secrets.r2SecretAccessKey ?? existing?.r2.secretAccessKey ?? "";
      const target: PublishTarget = {
        id: args.draft.id,
        label: args.draft.label,
        r2: {
          accountId: args.draft.r2.accountId,
          accessKeyId: args.draft.r2.accessKeyId,
          secretAccessKey: r2SecretAccessKey,
          bucket: args.draft.r2.bucket,
          region: args.draft.r2.region
        },
        bucketBaseUrl: args.draft.bucketBaseUrl,
        viewerUrl: args.draft.viewerUrl,
        selfHosted: args.draft.selfHosted
          ? {
              vercelTokenEncryptedBase64: existing?.selfHosted?.vercelTokenEncryptedBase64,
              vercelProjectId: args.draft.selfHosted.vercelProjectId,
              vercelTeamId: args.draft.selfHosted.vercelTeamId
            }
          : undefined,
        manifestRetention: args.draft.manifestRetention
      };
      return await verifyTarget({ target, skipNetwork: args.skipNetwork });
    }
  );

  ipcMain.handle(
    "publish:start",
    async (event, args: PublishStartRequest): Promise<PublishStartAck> => {
      const jobId = randomUUID();
      const abort = new AbortController();
      inFlightPublishJobs.set(jobId, abort);

      const sender = event.sender;
      const send = (eventPayload: PublishProgressEvent): void => {
        if (!sender.isDestroyed()) {
          sender.send("publish:progress", eventPayload);
        }
      };

      void (async () => {
        try {
          const settings = await loadPublishSettings(getPublishSettingsFilePath());
          const target = findTarget(settings, args.targetId);
          if (!target) {
            throw new Error(`Publish target not found: ${args.targetId}`);
          }
          const projectFolder = projectFolderForPath(args.projectPath);
          const pointer = await readPointer(args.projectPath);
          const projectName = projectNameFromSimularcaPath(args.projectPath);
          const buildInfo = loadEditorBuildInfo();
          const result = await startPublish({
            jobId,
            publishId: args.publishId,
            projectFolder,
            projectUuid: pointer.uuid,
            projectName,
            snapshotNames: args.snapshotNames,
            title: args.title,
            viewerConfig: args.viewerConfig,
            target,
            // Honour an explicit override (used by the "Use last deployed
            // viewer" CTA), otherwise pin to the editor's current sha.
            requiredViewerSha: args.requiredViewerShaOverride?.trim() || buildInfo.commitShortSha,
            appVersion: buildInfo.version,
            viewerExternalsPath: path.join(getRepoRoot(), "viewer-externals.json"),
            discoveredPlugins: discoverInstalledPlugins(),
            thumbnail: args.thumbnail
              ? {
                  bytes: Buffer.from(args.thumbnail.bytes),
                  width: args.thumbnail.width,
                  height: args.thumbnail.height,
                  contentType: args.thumbnail.contentType
                }
              : undefined,
            signal: abort.signal,
            onProgress: (progress: ServicePublishProgressEvent) => send(progress)
          });
          const refreshed = await loadPublishSettings(getPublishSettingsFilePath());
          const updated = recordPublish(refreshed, pointer.uuid, {
            publishId: result.publishId,
            title: args.title,
            lastPublishedAtIso: new Date().toISOString(),
            targetId: args.targetId,
            viewerUrl: result.viewerUrl,
            requiredViewerSha: result.requiredViewerSha,
            referencedBlobs: result.referencedBlobs
          });
          await savePublishSettings(getPublishSettingsFilePath(), updated);
        } catch (error) {
          send({
            jobId,
            phase: "error",
            error: error instanceof Error ? error.message : String(error)
          });
          void writeRuntimeLog("publish", "publish job failed", { jobId, error }, "error");
        } finally {
          inFlightPublishJobs.delete(jobId);
        }
      })();

      return { jobId };
    }
  );

  ipcMain.handle("publish:cancel", async (_event, args: { jobId: string }): Promise<void> => {
    const abort = inFlightPublishJobs.get(args.jobId);
    abort?.abort();
  });

  ipcMain.handle(
    "publish:set-default-layout",
    async (_event, args: { layout: unknown | null }): Promise<RedactedPublishSettings> => {
      const existing = await loadPublishSettings(getPublishSettingsFilePath());
      const next = setDefaultPublishLayout(existing, args.layout ?? undefined);
      await savePublishSettings(getPublishSettingsFilePath(), next);
      return redactSettings(next);
    }
  );

  ipcMain.handle(
    "publish:set-default-permissions",
    async (_event, args: { permissions: unknown | null }): Promise<RedactedPublishSettings> => {
      const existing = await loadPublishSettings(getPublishSettingsFilePath());
      const next = setDefaultViewerPermissions(existing, args.permissions ?? undefined);
      await savePublishSettings(getPublishSettingsFilePath(), next);
      return redactSettings(next);
    }
  );

  // -- Vercel viewer-deployment IPC ---------------------------------------
  ipcMain.handle("publish:open-vercel-tokens", async (): Promise<void> => {
    await shell.openExternal("https://vercel.com/account/tokens");
  });

  ipcMain.handle(
    "shell:open-external",
    async (_event, args: { url: string }): Promise<void> => {
      const trimmed = args.url?.trim();
      if (!trimmed) return;
      // Only honour http/https schemes — never let the renderer hand us
      // arbitrary URIs that could trigger native handlers (file://, etc.).
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error(`Refusing to open URL with non-http(s) scheme: ${trimmed}`);
      }
      await shell.openExternal(trimmed);
    }
  );

  ipcMain.handle(
    "publish:verify-vercel-token",
    async (
      _event,
      args: { token: string; teamId?: string }
    ): Promise<VercelTokenVerifyResult> => {
      const result = await verifyVercelToken({ token: args.token, teamId: args.teamId });
      return result;
    }
  );

  ipcMain.handle(
    "publish:save-vercel-settings",
    async (
      _event,
      args: VercelSettingsWriteRequest
    ): Promise<RedactedPublishSettings> => {
      const existing = await loadPublishSettings(getPublishSettingsFilePath());
      let nextVercel = existing.viewerDeployment ?? undefined;
      if (args.clear) {
        // Wipe credentials entirely.
        const next: PublishSettings = { ...existing, viewerDeployment: undefined };
        await savePublishSettings(getPublishSettingsFilePath(), next);
        return redactSettings(next);
      }
      const tokenInput = args.token?.trim();
      if (tokenInput) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error(
            "Cannot store Vercel token: OS keychain is unavailable to safeStorage."
          );
        }
        const verify = await verifyVercelToken({ token: tokenInput, teamId: args.teamId });
        if (!verify.ok) {
          throw new Error(verify.error ?? "Vercel token verification failed.");
        }
        const accountLabel = verify.email ?? verify.username ?? "Vercel account";
        nextVercel = {
          vercelTokenEncryptedBase64: safeStorage.encryptString(tokenInput).toString("base64"),
          vercelProjectId: args.projectId ?? nextVercel?.vercelProjectId,
          vercelProjectName: args.projectName ?? nextVercel?.vercelProjectName,
          vercelTeamId: args.teamId ?? nextVercel?.vercelTeamId,
          cachedAccountLabel: accountLabel,
          lastVerifiedAtIso: new Date().toISOString()
        };
      } else {
        // No new token — patch the non-secret fields only.
        if (!nextVercel) {
          throw new Error("No Vercel credentials configured yet — provide a token.");
        }
        nextVercel = {
          ...nextVercel,
          vercelProjectId: args.projectId ?? nextVercel.vercelProjectId,
          vercelProjectName: args.projectName ?? nextVercel.vercelProjectName,
          vercelTeamId: args.teamId ?? nextVercel.vercelTeamId
        };
      }
      const next: PublishSettings = { ...existing, viewerDeployment: nextVercel };
      await savePublishSettings(getPublishSettingsFilePath(), next);
      return redactSettings(next);
    }
  );

  ipcMain.handle(
    "publish:deploy-viewer",
    async (event, _args: Record<string, never> | undefined): Promise<{ jobId: string }> => {
      const jobId = randomUUID();
      const abort = new AbortController();
      inFlightPublishJobs.set(jobId, abort);
      const sender = event.sender;
      const send = (payload: DeployViewerProgressIpcEvent): void => {
        if (!sender.isDestroyed()) sender.send("publish:viewer-deploy-progress", payload);
      };

      void (async () => {
        try {
          const settings = await loadPublishSettings(getPublishSettingsFilePath());
          const vercel = settings.viewerDeployment;
          if (!vercel?.vercelTokenEncryptedBase64) {
            throw new Error(
              "No Vercel credentials configured. Open the Vercel settings and paste a token first."
            );
          }
          const token = safeStorage.decryptString(
            Buffer.from(vercel.vercelTokenEncryptedBase64, "base64")
          );
          const projectName = vercel.vercelProjectName?.trim() || "simularca-viewer";
          send({ jobId, phase: "build", message: "Building viewer bundle…" });
          // Clean dist/ first so stale editor outputs from a prior `vite build`
          // don't ship to the public viewer deployment.
          try {
            await fs.rm(path.join(getRepoRoot(), "dist"), { recursive: true, force: true });
          } catch {
            // ignore — dist may not exist yet
          }
          await runViewerBuild({
            onStdout: (line) => send({ jobId, phase: "build", message: line }),
            onStderr: (line) => send({ jobId, phase: "build", message: line }),
            signal: abort.signal
          });
          send({ jobId, phase: "project", message: `Resolving project "${projectName}"…` });
          const project = await ensureVercelProject({
            token,
            teamId: vercel.vercelTeamId,
            name: projectName
          });
          if (project.created) {
            send({ jobId, phase: "project", message: `Created Vercel project "${project.name}".` });
          }
          // Persist resolved project id so subsequent deploys map to the same project.
          const refreshed = await loadPublishSettings(getPublishSettingsFilePath());
          if (refreshed.viewerDeployment) {
            await savePublishSettings(getPublishSettingsFilePath(), {
              ...refreshed,
              viewerDeployment: {
                ...refreshed.viewerDeployment,
                vercelProjectId: project.projectId,
                vercelProjectName: project.name
              }
            });
          }
          const buildInfo = loadEditorBuildInfo();
          const distDir = path.join(getRepoRoot(), "dist");
          // Ship a stripped-down vercel.json inside dist/ so the rewrites +
          // headers apply at runtime. We MUST drop the repo's
          // `buildCommand`/`outputDirectory`/`framework`: the deploy target is
          // the already-built `dist/`, and if Vercel sees a buildCommand it
          // will try to re-run the editor build inside its sandbox (which
          // doesn't have the source tree). `framework: null` keeps the
          // platform's autodetection from second-guessing the upload.
          try {
            const repoVercelRaw = await fs.readFile(
              path.join(getRepoRoot(), "vercel.json"),
              "utf8"
            );
            const repoVercel = JSON.parse(repoVercelRaw) as Record<string, unknown>;
            const {
              buildCommand: _b,
              outputDirectory: _o,
              framework: _f,
              ...rest
            } = repoVercel;
            void _b; void _o; void _f;
            const deployVercel = { ...rest, framework: null };
            await fs.writeFile(
              path.join(distDir, "vercel.json"),
              JSON.stringify(deployVercel, null, 2)
            );
          } catch {
            // If we can't write it, deploy continues — but rewrites won't work
            // and the viewer URL won't be reachable. Surface as a warning.
            send({
              jobId,
              phase: "build",
              message: "WARNING: could not write vercel.json into dist/. Rewrites may not apply."
            });
          }
          // Copy middleware.ts into dist/ so Vercel autodetects it as a
          // routing middleware. Without this, /v/:sha/p/:id URLs go
          // straight through the vercel.json rewrite and crawlers see the
          // generic viewer.html with no per-publish OpenGraph tags.
          try {
            await fs.copyFile(
              path.join(getRepoRoot(), "middleware.ts"),
              path.join(distDir, "middleware.ts")
            );
          } catch {
            send({
              jobId,
              phase: "build",
              message: "WARNING: could not copy middleware.ts into dist/. Social-card thumbnails will not be injected."
            });
          }
          send({ jobId, phase: "deploy", message: "Uploading bundle to Vercel…" });
          const result = await deployViewer({
            token,
            teamId: vercel.vercelTeamId,
            projectName: project.name,
            distDir,
            sha: buildInfo.commitShortSha,
            signal: abort.signal,
            onProgress: (progress: DeployViewerProgressEvent) => {
              // Translate vercelDeploy's phase vocabulary to the IPC event's
              // simpler vocabulary. "preparing"/"uploading" both surface as
              // "deploy"; "ready" stays as "ready"; final done emit happens
              // after this loop returns.
              const phase: DeployViewerProgressIpcEvent["phase"] =
                progress.phase === "preparing" || progress.phase === "uploading"
                  ? "deploy"
                  : progress.phase === "deploying"
                    ? "deploy"
                    : progress.phase === "ready"
                      ? "ready"
                      : "error";
              send({
                jobId,
                phase,
                message: progress.message,
                uploadedFiles: progress.uploadedFiles,
                totalFiles: progress.totalFiles,
                uploadedBytes: progress.uploadedBytes,
                totalBytes: progress.totalBytes,
                url: progress.url,
                error: progress.error
              });
            }
          });
          // Persist the deployed sha so the publish UI can offer "Use last
          // deployed viewer" as a fallback when the editor's current sha
          // doesn't have a viewer deployed.
          {
            const fresh = await loadPublishSettings(getPublishSettingsFilePath());
            if (fresh.viewerDeployment) {
              await savePublishSettings(getPublishSettingsFilePath(), {
                ...fresh,
                viewerDeployment: {
                  ...fresh.viewerDeployment,
                  lastDeployedSha: buildInfo.commitShortSha,
                  lastDeployedAtIso: new Date().toISOString()
                }
              });
            }
          }
          send({
            jobId,
            phase: "done",
            url: result.url ? `https://${result.url}` : undefined,
            message: `Deployment ready. View: https://${result.url}`
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ jobId, phase: "error", error: message });
          void writeRuntimeLog("publish", "viewer deploy failed", { jobId, error }, "error");
        } finally {
          inFlightPublishJobs.delete(jobId);
        }
      })();

      return { jobId };
    }
  );

  ipcMain.handle(
    "publish:delete",
    async (
      _event,
      args: { targetId: string; publishId: string }
    ): Promise<PublishDeleteResult> => {
      const settings = await loadPublishSettings(getPublishSettingsFilePath());
      const target = findTarget(settings, args.targetId);
      if (!target) {
        throw new Error(`Publish target not found: ${args.targetId}`);
      }
      // Find the entry being deleted.
      let foundEntry: ListedPublish | null = null;
      for (const entries of Object.values(settings.publishesByProjectUuid)) {
        const match = entries.find((entry) => entry.publishId === args.publishId);
        if (match) {
          foundEntry = match;
          break;
        }
      }
      if (!foundEntry) {
        throw new Error(`Publish ${args.publishId} not found in publish-settings.json.`);
      }

      // Build the set of bucket keys that are STILL referenced by some other
      // publish on the same target. After this delete, any key NOT in that
      // set is orphaned and safe to purge — even content-addressed assets
      // and plugin bundles. Reduces bucket bloat over time.
      const stillReferenced = new Set<string>();
      for (const entries of Object.values(settings.publishesByProjectUuid)) {
        for (const entry of entries) {
          if (entry.publishId === args.publishId) continue;
          if (entry.targetId !== args.targetId) continue;
          for (const blob of entry.referencedBlobs) {
            stillReferenced.add(blob.key);
          }
        }
      }

      const blobsToDelete: { key: string; kind: string; byteSize: number }[] = [];
      let bytesFreed = 0;
      for (const blob of foundEntry.referencedBlobs) {
        const isPerPublish =
          blob.kind === "manifest" ||
          blob.kind === "snapshot" ||
          blob.kind === "config" ||
          blob.kind === "latest";
        const isOrphanedShared =
          (blob.kind === "asset" || blob.kind === "plugin") && !stillReferenced.has(blob.key);
        if (isPerPublish || isOrphanedShared) {
          blobsToDelete.push({ key: blob.key, kind: blob.kind, byteSize: blob.byteSize });
        }
      }

      const client = new S3Client({
        region: target.r2.region ?? "auto",
        endpoint: `https://${target.r2.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: target.r2.accessKeyId,
          secretAccessKey: target.r2.secretAccessKey
        }
      });
      const failed: string[] = [];
      for (const blob of blobsToDelete) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: target.r2.bucket, Key: blob.key }));
          bytesFreed += blob.byteSize;
        } catch (error) {
          failed.push(blob.key);
          void writeRuntimeLog(
            "publish",
            "delete-blob failed (continuing)",
            { key: blob.key, error: error instanceof Error ? error.message : error },
            "warn"
          );
        }
      }

      // Remove from publish-settings.json
      const nextPublishesByUuid: PublishSettings["publishesByProjectUuid"] = {};
      for (const [uuid, list] of Object.entries(settings.publishesByProjectUuid)) {
        nextPublishesByUuid[uuid] = list.filter((entry) => entry.publishId !== args.publishId);
      }
      const next: PublishSettings = { ...settings, publishesByProjectUuid: nextPublishesByUuid };
      await savePublishSettings(getPublishSettingsFilePath(), next);

      const deletedSharedCount = blobsToDelete.filter(
        (b) => b.kind === "asset" || b.kind === "plugin"
      ).length;
      const retainedSharedCount = foundEntry.referencedBlobs.filter(
        (b) => (b.kind === "asset" || b.kind === "plugin") && stillReferenced.has(b.key)
      ).length;

      return {
        settings: redactSettings(next),
        bytesFreed,
        deletedBlobCount: blobsToDelete.length,
        deletedSharedCount,
        retainedSharedCount,
        failedKeyCount: failed.length
      };
    }
  );

  ipcMain.handle(
    "publish:rollback",
    async (_event, args: PublishRollbackRequest): Promise<void> => {
      const settings = await loadPublishSettings(getPublishSettingsFilePath());
      const target = findTarget(settings, args.targetId);
      if (!target) {
        throw new Error(`Publish target not found: ${args.targetId}`);
      }
      const client = new S3Client({
        region: target.r2.region ?? "auto",
        endpoint: `https://${target.r2.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: target.r2.accessKeyId,
          secretAccessKey: target.r2.secretAccessKey
        }
      });
      const latestPayload = JSON.stringify(
        { latestVersion: 1, manifestUrl: `manifest-${args.manifestSha}.json` },
        null,
        2
      );
      await client.send(
        new PutObjectCommand({
          Bucket: target.r2.bucket,
          Key: `publishes/${args.publishId}/latest.json`,
          Body: Buffer.from(latestPayload, "utf8"),
          ContentType: "application/json; charset=utf-8",
          CacheControl: "public, max-age=60, must-revalidate"
        })
      );
    }
  );

  // Suppress unused-import lint for the decrypt helper (used by future
  // self-hosted-deploy IPC; kept exported here so the safeStorage round-trip
  // is verified by typecheck).
  void decryptVercelToken;
}

void app.whenReady().then(async () => {
  process.on("uncaughtException", (error) => {
    if (isIgnorablePipeError(error)) {
      void writeRuntimeLog("process", "ignored uncaught transport disconnect", error);
      return;
    }
    void writeRuntimeLog("process", "uncaughtException", error, "error");
  });
  process.on("unhandledRejection", (reason) => {
    void writeRuntimeLog("process", "unhandledRejection", reason, "error");
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    void writeRuntimeLog("app", "render-process-gone", {
      url: webContents.getURL(),
      details
    }, "error");
  });
  app.on("child-process-gone", (_event, details) => {
    void writeRuntimeLog("app", "child-process-gone", details, "warn");
  });

  void writeRuntimeLog("app", "App starting", {
    isDev: IS_DEV,
    devServerUrl: DEV_SERVER_URL ?? null,
    userDataRoot: getUserDataRoot(),
    remoteDebuggingPort: IS_DEV ? REMOTE_DEBUGGING_PORT : null,
    crashpadDirectory: app.getPath("crashDumps")
  });
  migrateLegacyWindowState();
  const pushRotoState = (state: RotoControlState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("roto-control:state", state);
    }
  };
  const pushRotoInput = (event: RotoControlInputEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("roto-control:input", event);
    }
  };
  rotoControlHost = new RotoControlHost({
    emitState: pushRotoState,
    emitInput: pushRotoInput,
    log: (message, metadata) => {
      void writeRuntimeLog("roto", message, metadata);
    }
  });
  await registerAssetProtocol();
  registerIpcHandlers();
  liveDebugServerController = await startLiveDebugServer({
    buildKind: IS_DEV ? "dev" : "build",
    getLogsRoot,
    getRuntimeLogFilePath,
    writeRuntimeLog
  });
  if (liveDebugServerController) {
    void writeRuntimeLog("debug-bridge", "Manifest ready", {
      manifestPath: getCodexDebugManifestFilePath()
    });
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  void writeRuntimeLog("app", "All windows closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  const activeController = liveDebugServerController;
  liveDebugServerController = null;
  void activeController?.dispose();
  rotoControlHost?.dispose();
  rotoControlHost = null;
});

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, type OpenDialogOptions } from "electron";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { DefaultSessionPointer, FileDialogFilter, HdriTranscodeOptions, SessionAssetRef } from "../src/types/ipc";
import { createSplatBinaryV1 } from "./splatBinaryFormat.js";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);
const DEFAULTS_FILE_NAME = "defaults.json";
const SESSION_FILE_NAME = "session.json";
const RUNTIME_LOG_FILE_NAME = "electron-runtime.log";
const WINDOW_STATE_FILE_NAME = "window-state.json";
const ASSET_PROTOCOL = "simularcaasset";
const DEFAULT_WINDOW_WIDTH = 1680;
const DEFAULT_WINDOW_HEIGHT = 960;
const MIN_WINDOW_WIDTH = 1200;
const MIN_WINDOW_HEIGHT = 720;

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

function getRuntimeLogFilePath(): string {
  return path.join(getLogsRoot(), RUNTIME_LOG_FILE_NAME);
}

function toErrorPayload(input: unknown): Record<string, unknown> {
  if (input instanceof Error) {
    return {
      name: input.name,
      message: input.message,
      stack: input.stack
    };
  }
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  return {
    value: String(input)
  };
}

function writeRuntimeLog(scope: string, message: string, metadata?: unknown): void {
  const timestamp = new Date().toISOString();
  const serialized = metadata === undefined ? "" : ` ${JSON.stringify(toErrorPayload(metadata))}`;
  const line = `[${timestamp}] [${scope}] ${message}${serialized}`;
  console.log(line);
  try {
    fsSync.mkdirSync(getLogsRoot(), { recursive: true });
    fsSync.appendFileSync(getRuntimeLogFilePath(), `${line}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write runtime log", error);
  }
}

void writeRuntimeLog("boot", "electron main module loaded", {
  cwd: process.cwd(),
  node: process.version,
  platform: process.platform
});

function getSaveDataRoot(): string {
  return path.join(getRepoRoot(), "savedata");
}

function getSessionDirectory(sessionName: string): string {
  return path.join(getSaveDataRoot(), sessionName);
}

interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

function getWindowStateFilePath(): string {
  return path.join(getSaveDataRoot(), WINDOW_STATE_FILE_NAME);
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
    void writeRuntimeLog("window", "Failed to read persisted window state", error);
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
    fsSync.mkdirSync(getSaveDataRoot(), { recursive: true });
    fsSync.writeFileSync(getWindowStateFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    void writeRuntimeLog("window", "Failed to persist window state", error);
  }
}

function getSessionFile(sessionName: string): string {
  return path.join(getSessionDirectory(sessionName), SESSION_FILE_NAME);
}

function getAssetDirectory(sessionName: string, kind: SessionAssetRef["kind"]): string {
  return path.join(getSessionDirectory(sessionName), "assets", kind);
}

async function discoverLocalPlugins(): Promise<Array<{ modulePath: string; sourceGroup: "plugins-local" | "plugins" }>> {
  const roots: Array<{ sourceGroup: "plugins-local" | "plugins"; directory: string }> = [
    { sourceGroup: "plugins-local", directory: path.join(getRepoRoot(), "plugins-local") },
    { sourceGroup: "plugins", directory: path.join(getRepoRoot(), "plugins") }
  ];
  const discovered: Array<{ modulePath: string; sourceGroup: "plugins-local" | "plugins" }> = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root.directory, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      for (const childName of directories) {
        const builtEntry = path.join(root.directory, childName, "dist", "index.js");
        try {
          await fs.access(builtEntry);
          discovered.push({
            modulePath: `file:///${builtEntry.replaceAll("\\", "/")}`,
            sourceGroup: root.sourceGroup
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
      const sessionName = decodeURIComponent(parsed.hostname);
      const relativeParts = parsed.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));
      const relativePath = relativeParts.join("/");
      const sessionRoot = path.resolve(getSessionDirectory(sessionName));
      const targetPath = path.resolve(sessionRoot, relativePath);
      if (!targetPath.startsWith(sessionRoot)) {
        return new Response("Invalid asset path", { status: 400 });
      }
      const content = await fs.readFile(targetPath);
      return new Response(content, {
        status: 200,
        headers: {
          "content-type": mimeTypeForPath(targetPath)
        }
      });
    } catch (error) {
      void writeRuntimeLog("asset-protocol", "Failed to resolve request", {
        url: request.url,
        error
      });
      return new Response("Not found", { status: 404 });
    }
  });
}

async function ensureSessionDirectory(sessionName: string): Promise<void> {
  await fs.mkdir(getSessionDirectory(sessionName), { recursive: true });
  await fs.mkdir(path.join(getSessionDirectory(sessionName), "assets"), { recursive: true });
}

async function ensureDefaultsFile(): Promise<void> {
  const defaultsPath = path.join(getSaveDataRoot(), DEFAULTS_FILE_NAME);
  try {
    await fs.access(defaultsPath);
  } catch {
    const defaults: DefaultSessionPointer = { defaultSessionName: "demo" };
    await fs.mkdir(getSaveDataRoot(), { recursive: true });
    await fs.writeFile(defaultsPath, JSON.stringify(defaults, null, 2), "utf8");
  }
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

function createWindow(): BrowserWindow {
  const persisted = readPersistedWindowState();
  const usePersistedBounds = persisted && isWindowBoundsVisible(persisted);
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
    webPreferences: {
      preload: path.join(getRepoRoot(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
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
      });
    }
  );

  mainWindow.webContents.on("did-finish-load", () => {
    void writeRuntimeLog("webcontents", "did-finish-load", {
      url: mainWindow.webContents.getURL()
    });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void writeRuntimeLog("webcontents", "render-process-gone", details);
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    void writeRuntimeLog("webcontents", "preload-error", {
      preloadPath,
      error: toErrorPayload(error)
    });
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level <= 1) {
      return;
    }
    void writeRuntimeLog("renderer-console", "console-message", {
      level,
      message,
      line,
      sourceId
    });
  });

  mainWindow.on("unresponsive", () => {
    void writeRuntimeLog("window", "BrowserWindow became unresponsive");
  });

  mainWindow.on("closed", () => {
    void writeRuntimeLog("window", "BrowserWindow closed");
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
      isMaximized: mainWindow.isMaximized()
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
  mainWindow.on("close", persistCurrentWindowState);
  mainWindow.webContents.once("did-finish-load", () => {
    pushWindowState();
  });

  if (persisted?.isMaximized) {
    mainWindow.maximize();
  }

  if (IS_DEV && DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL).catch((error) => {
      void writeRuntimeLog("window", "Failed to load DEV server URL", error);
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html")).catch((error) => {
      void writeRuntimeLog("window", "Failed to load production index.html", error);
    });
  }

  return mainWindow;
}

function registerIpcHandlers(): void {
  ipcMain.on("renderer:runtime-error", (_event, payload: unknown) => {
    void writeRuntimeLog("renderer", "runtime-error", payload);
  });

  ipcMain.handle("mode:get", () => "electron-rw");
  ipcMain.handle("window:get-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { isMaximized: win?.isMaximized() ?? false };
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
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
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
      { role: "help", submenu: [{ label: "Simularca", enabled: false }] }
    ]);
    menu.popup({
      window: win,
      x: Math.max(0, Math.floor(args.x)),
      y: Math.max(0, Math.floor(args.y))
    });
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

  ipcMain.handle("plugins:discover-local", async () => {
    return await discoverLocalPlugins();
  });

  ipcMain.handle("sessions:list", async () => {
    await fs.mkdir(getSaveDataRoot(), { recursive: true });
    const entries = await fs.readdir(getSaveDataRoot(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle("defaults:load", async () => {
    await ensureDefaultsFile();
    const raw = await fs.readFile(path.join(getSaveDataRoot(), DEFAULTS_FILE_NAME), "utf8");
    return JSON.parse(raw) as DefaultSessionPointer;
  });

  ipcMain.handle("defaults:save", async (_event, pointer: DefaultSessionPointer) => {
    await fs.mkdir(getSaveDataRoot(), { recursive: true });
    await fs.writeFile(path.join(getSaveDataRoot(), DEFAULTS_FILE_NAME), JSON.stringify(pointer, null, 2), "utf8");
  });

  ipcMain.handle("session:load", async (_event, sessionName: string) => {
    await ensureSessionDirectory(sessionName);
    const sessionFile = getSessionFile(sessionName);
    try {
      await fs.access(sessionFile);
    } catch {
      await fs.writeFile(sessionFile, "{}", "utf8");
    }
    return fs.readFile(sessionFile, "utf8");
  });

  ipcMain.handle("session:save", async (_event, sessionName: string, payload: string) => {
    await ensureSessionDirectory(sessionName);
    await fs.writeFile(getSessionFile(sessionName), payload, "utf8");
  });
  ipcMain.handle(
    "session:clone",
    async (
      _event,
      args: {
        previousName: string;
        nextName: string;
      }
    ) => {
      if (args.previousName === args.nextName) {
        return;
      }
      const fromDir = getSessionDirectory(args.previousName);
      const toDir = getSessionDirectory(args.nextName);
      await ensureSessionDirectory(args.previousName);
      try {
        await fs.access(toDir);
        throw new Error(`Session "${args.nextName}" already exists.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      await fs.cp(fromDir, toDir, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
    }
  );
  ipcMain.handle(
    "session:rename",
    async (
      _event,
      args: {
        previousName: string;
        nextName: string;
      }
    ) => {
      const fromDir = getSessionDirectory(args.previousName);
      const toDir = getSessionDirectory(args.nextName);
      if (args.previousName === args.nextName) {
        return;
      }
      try {
        await fs.access(toDir);
        throw new Error(`Session "${args.nextName}" already exists.`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          throw error;
        }
      }
      try {
        await fs.rename(fromDir, toDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") {
          throw error;
        }
        // Windows can lock active files (e.g. currently loaded assets). Fallback to copy + best-effort cleanup.
        await fs.cp(fromDir, toDir, {
          recursive: true,
          errorOnExist: true,
          force: false
        });
        try {
          await fs.rm(fromDir, {
            recursive: true,
            force: true
          });
        } catch (cleanupError) {
          void writeRuntimeLog("session:rename", "Unable to remove old session directory after fallback copy", {
            previousName: args.previousName,
            nextName: args.nextName,
            cleanupError
          });
        }
      }
      const defaultsPath = path.join(getSaveDataRoot(), DEFAULTS_FILE_NAME);
      try {
        const raw = await fs.readFile(defaultsPath, "utf8");
        const current = JSON.parse(raw) as DefaultSessionPointer;
        if (current.defaultSessionName === args.previousName) {
          await fs.writeFile(
            defaultsPath,
            JSON.stringify({ defaultSessionName: args.nextName } satisfies DefaultSessionPointer, null, 2),
            "utf8"
          );
        }
      } catch {
        // defaults file may be absent; ignore.
      }
    }
  );

  ipcMain.handle(
    "asset:import",
    async (
      _event,
      args: {
        sessionName: string;
        sourcePath: string;
        kind: SessionAssetRef["kind"];
      }
    ) => {
      await ensureSessionDirectory(args.sessionName);
      const sourceFileName = path.basename(args.sourcePath);
      const extension = path.extname(sourceFileName);
      const targetName = `${Date.now()}-${randomUUID()}${extension}`;
      const assetDirectory = getAssetDirectory(args.sessionName, args.kind);
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetPath = path.join(assetDirectory, targetName);
      await fs.copyFile(args.sourcePath, targetPath);
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(getSessionDirectory(args.sessionName), targetPath).replaceAll("\\", "/");

      const assetRef: SessionAssetRef = {
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
    "asset:import-gaussian",
    async (
      _event,
      args: {
        sessionName: string;
        sourcePath: string;
      }
    ) => {
      await ensureSessionDirectory(args.sessionName);
      const sourceFileName = path.basename(args.sourcePath);
      const payload = Uint8Array.from(await fs.readFile(args.sourcePath));
      const binary = createSplatBinaryV1(payload, "ply");
      const targetName = `${Date.now()}-${randomUUID()}.splatbin`;
      const assetDirectory = getAssetDirectory(args.sessionName, "gaussian-splat");
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetPath = path.join(assetDirectory, targetName);
      await fs.writeFile(targetPath, binary);
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(getSessionDirectory(args.sessionName), targetPath).replaceAll("\\", "/");
      const assetRef: SessionAssetRef = {
        id: randomUUID(),
        kind: "gaussian-splat",
        encoding: "splatbin-v1",
        relativePath,
        sourceFileName,
        byteSize: stat.size
      };
      return assetRef;
    }
  );

  ipcMain.handle(
    "asset:convert-gaussian",
    async (
      _event,
      args: {
        sessionName: string;
        assetId: string;
        relativePath: string;
        sourceFileName: string;
      }
    ) => {
      await ensureSessionDirectory(args.sessionName);
      const sessionRoot = path.resolve(getSessionDirectory(args.sessionName));
      const sourcePath = path.resolve(sessionRoot, args.relativePath);
      if (!sourcePath.startsWith(sessionRoot)) {
        throw new Error("Invalid asset path");
      }
      const payload = Uint8Array.from(await fs.readFile(sourcePath));
      const binary = createSplatBinaryV1(payload, "ply");
      const targetName = `${Date.now()}-${randomUUID()}.splatbin`;
      const assetDirectory = getAssetDirectory(args.sessionName, "gaussian-splat");
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetPath = path.join(assetDirectory, targetName);
      await fs.writeFile(targetPath, binary);
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(getSessionDirectory(args.sessionName), targetPath).replaceAll("\\", "/");
      return {
        id: args.assetId,
        kind: "gaussian-splat",
        encoding: "splatbin-v1",
        relativePath,
        sourceFileName: args.sourceFileName,
        byteSize: stat.size
      } satisfies SessionAssetRef;
    }
  );

  ipcMain.handle(
    "asset:transcode-hdri",
    async (
      _event,
      args: {
        sessionName: string;
        sourcePath: string;
        options?: HdriTranscodeOptions;
      }
    ) => {
      await ensureSessionDirectory(args.sessionName);
      const assetDirectory = getAssetDirectory(args.sessionName, "hdri");
      await fs.mkdir(assetDirectory, { recursive: true });
      const targetName = `${Date.now()}-${randomUUID()}.ktx2`;
      const targetPath = path.join(assetDirectory, targetName);
      await runToktx({
        inputPath: args.sourcePath,
        outputPath: targetPath,
        options: args.options
      });
      const stat = await fs.stat(targetPath);
      const relativePath = path.relative(getSessionDirectory(args.sessionName), targetPath).replaceAll("\\", "/");
      const sourceFileName = path.basename(args.sourcePath);
      const assetRef: SessionAssetRef = {
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
        sessionName: string;
        relativePath: string;
      }
    ) => {
      const absolute = path.resolve(getSessionDirectory(args.sessionName), args.relativePath);
      await fs.rm(absolute, { force: true });
    }
  );

  ipcMain.handle(
    "asset:resolve-path",
    async (
      _event,
      args: {
        sessionName: string;
        relativePath: string;
      }
    ) => {
      const encodedSession = encodeURIComponent(args.sessionName);
      const encodedPath = args.relativePath
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
      return `${ASSET_PROTOCOL}://${encodedSession}/${encodedPath}`;
    }
  );

  ipcMain.handle(
    "asset:read-bytes",
    async (
      _event,
      args: {
        sessionName: string;
        relativePath: string;
      }
    ) => {
      const sessionRoot = path.resolve(getSessionDirectory(args.sessionName));
      const absolutePath = path.resolve(sessionRoot, args.relativePath);
      if (!absolutePath.startsWith(sessionRoot)) {
        throw new Error("Invalid asset path");
      }
      const bytes = await fs.readFile(absolutePath);
      return Uint8Array.from(bytes);
    }
  );
}

void app.whenReady().then(async () => {
  process.on("uncaughtException", (error) => {
    void writeRuntimeLog("process", "uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    void writeRuntimeLog("process", "unhandledRejection", reason);
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    void writeRuntimeLog("app", "render-process-gone", {
      url: webContents.getURL(),
      details
    });
  });
  app.on("child-process-gone", (_event, details) => {
    void writeRuntimeLog("app", "child-process-gone", details);
  });

  void writeRuntimeLog("app", "App starting", {
    isDev: IS_DEV,
    devServerUrl: DEV_SERVER_URL ?? null
  });
  await ensureDefaultsFile();
  await registerAssetProtocol();
  registerIpcHandlers();
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

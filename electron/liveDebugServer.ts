import { app, BrowserWindow, dialog, ipcMain, webContents } from "electron";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  CodexDebugSessionManifest,
  CodexDebugSessionWindowInfo,
  LiveDebugExecutionResult,
  MainDebugExecuteRequest,
  RendererDebugExecuteRequest
} from "../src/types/ipc";

const MANIFEST_FILE_NAME = "codex-debug-session.json";

export interface LiveDebugServerController {
  dispose(): Promise<void>;
  refreshManifest(): Promise<void>;
}

interface LiveDebugServerOptions {
  buildKind: "dev" | "build";
  getLogsRoot(): string;
  getRuntimeLogFilePath(): string;
  writeRuntimeLog(scope: string, message: string, metadata?: unknown): void;
}

interface JsonResponseInit {
  status?: number;
}

export function isIgnorablePipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
  if (code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || code === "ERR_SOCKET_CLOSED") {
    return true;
  }
  const message =
    "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
  return /broken pipe|socket hang up|write after end/i.test(message);
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toExecutionError(summary: string, error: unknown, details?: unknown): LiveDebugExecutionResult {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return {
    ok: false,
    summary,
    error: message,
    details: details === undefined ? serializeUnknown(error) : serializeUnknown(details)
  };
}

function listWindows(): CodexDebugSessionWindowInfo[] {
  return BrowserWindow.getAllWindows().map((window) => ({
    id: window.id,
    title: window.getTitle(),
    url: window.webContents.getURL(),
    focused: window.isFocused(),
    visible: window.isVisible()
  }));
}

function resolveTargetWindow(windowId?: number): BrowserWindow | null {
  if (typeof windowId === "number" && Number.isFinite(windowId)) {
    return BrowserWindow.fromId(windowId) ?? null;
  }
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function getManifestPath(getLogsRoot: () => string): string {
  return path.join(getLogsRoot(), MANIFEST_FILE_NAME);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function writeJson(response: ServerResponse, payload: unknown, init: JsonResponseInit = {}): void {
  response.statusCode = init.status ?? 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

export function canWriteJsonResponse(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded && !(response.socket?.destroyed ?? false);
}

export function writeJsonSafe(response: ServerResponse, payload: unknown, init: JsonResponseInit = {}): boolean {
  if (!canWriteJsonResponse(response)) {
    return false;
  }
  try {
    writeJson(response, payload, init);
    return true;
  } catch (error) {
    if (isIgnorablePipeError(error)) {
      return false;
    }
    throw error;
  }
}

async function tailRuntimeLog(filePath: string, maxLines: number): Promise<{ filePath: string; lineCount: number; lines: string[] }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    const safeMaxLines = Number.isFinite(maxLines) ? Math.max(1, Math.min(1000, Math.floor(maxLines))) : 200;
    return {
      filePath,
      lineCount: lines.length,
      lines: lines.slice(-safeMaxLines)
    };
  } catch (error) {
    return {
      filePath,
      lineCount: 0,
      lines: [`Unable to read runtime log: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function executeRendererCommand(request: RendererDebugExecuteRequest): Promise<LiveDebugExecutionResult> {
  const targetWindow = resolveTargetWindow(request.windowId);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return {
      ok: false,
      summary: "Renderer unavailable.",
      error: "No Electron renderer window is available.",
      details: "Start a dev Electron window before using renderer debug commands."
    };
  }
  const methodName = request.mode === "eval" ? "executeEval" : "executeConsole";
  try {
    const result = (await targetWindow.webContents.executeJavaScript(
      `(() => {
        const bridge = window.__REHEARSE_ENGINE_DEBUG__;
        if (!bridge || typeof bridge.${methodName} !== "function") {
          return {
            ok: false,
            summary: "Renderer bridge unavailable.",
            error: "renderer bridge unavailable or reloading",
            details: "The dev renderer bridge is not installed yet, or Vite hot reload is currently remounting the app."
          };
        }
        return bridge.${methodName}(${JSON.stringify(request.source)});
      })()`,
      true
    )) as LiveDebugExecutionResult;
    return result;
  } catch (error) {
    return toExecutionError("Renderer execution failed.", error);
  }
}

async function executeRendererSessionInfo(): Promise<unknown> {
  const targetWindow = resolveTargetWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return null;
  }
  try {
    return await targetWindow.webContents.executeJavaScript(
      `(() => {
        const bridge = window.__REHEARSE_ENGINE_DEBUG__;
        if (!bridge || typeof bridge.sessionInfo !== "function") {
          return null;
        }
        return bridge.sessionInfo();
      })()`,
      true
    );
  } catch {
    return null;
  }
}

async function executeMainCommand(request: MainDebugExecuteRequest, runtimeLogFilePath: string): Promise<LiveDebugExecutionResult> {
  const AsyncFunction = Object.getPrototypeOf(async function () {
    return;
  }).constructor as new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;
  const allWindows = (): BrowserWindow[] => BrowserWindow.getAllWindows();
  const focusedWindow = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const runtimeLogTail = async (tail = 200) => await tailRuntimeLog(runtimeLogFilePath, tail);
  try {
    let result: unknown;
    try {
      const expressionFn = new AsyncFunction(
        "app",
        "BrowserWindow",
        "webContents",
        "ipcMain",
        "dialog",
        "process",
        "path",
        "fs",
        "mainWindow",
        "allWindows",
        "focusedWindow",
        "runtimeLogTail",
        `'use strict'; return await (${request.source});`
      );
      result = await expressionFn(
        app,
        BrowserWindow,
        webContents,
        ipcMain,
        dialog,
        process,
        path,
        fs,
        BrowserWindow.getAllWindows()[0] ?? null,
        allWindows(),
        focusedWindow,
        runtimeLogTail
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      const statementFn = new AsyncFunction(
        "app",
        "BrowserWindow",
        "webContents",
        "ipcMain",
        "dialog",
        "process",
        "path",
        "fs",
        "mainWindow",
        "allWindows",
        "focusedWindow",
        "runtimeLogTail",
        `'use strict'; return await (async () => {\n${request.source}\n})();`
      );
      result = await statementFn(
        app,
        BrowserWindow,
        webContents,
        ipcMain,
        dialog,
        process,
        path,
        fs,
        BrowserWindow.getAllWindows()[0] ?? null,
        allWindows(),
        focusedWindow,
        runtimeLogTail
      );
    }
    return {
      ok: true,
      summary: "Command executed.",
      result,
      details: serializeUnknown(result)
    };
  } catch (error) {
    return toExecutionError("Main-process command failed.", error);
  }
}

export async function startLiveDebugServer(options: LiveDebugServerOptions): Promise<LiveDebugServerController | null> {
  if (options.buildKind !== "dev") {
    return null;
  }

  await fs.mkdir(options.getLogsRoot(), { recursive: true });
  const token = randomBytes(24).toString("hex");
  const startedAtIso = new Date().toISOString();
  let server: http.Server | null = null;
  let port = 0;

  const writeManifest = async (): Promise<void> => {
    if (!port) {
      return;
    }
    const manifest: CodexDebugSessionManifest = {
      pid: process.pid,
      startedAtIso,
      port,
      token,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
      build: {
        appVersion: app.getVersion(),
        buildKind: options.buildKind,
        electronVersion: process.versions.electron ?? "",
        nodeVersion: process.version
      }
    };
    await fs.writeFile(getManifestPath(options.getLogsRoot), JSON.stringify(manifest, null, 2), "utf8");
  };

  const clearManifest = async (): Promise<void> => {
    await fs.rm(getManifestPath(options.getLogsRoot), { force: true });
  };

  server = http.createServer(async (request, response) => {
    response.on("error", (error) => {
      if (!isIgnorablePipeError(error)) {
        options.writeRuntimeLog("debug-bridge", "Response stream error", {
          method: request.method,
          url: request.url,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        });
      }
    });
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      writeJsonSafe(response, { error: "Loopback connections only." }, { status: 403 });
      return;
    }
    const authHeader = request.headers.authorization ?? "";
    if (authHeader !== `Bearer ${token}`) {
      writeJsonSafe(response, { error: "Unauthorized." }, { status: 401 });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJsonSafe(response, {
          ok: true,
          pid: process.pid,
          startedAtIso,
          windows: listWindows(),
          renderer: await executeRendererSessionInfo(),
          build: {
            appVersion: app.getVersion(),
            buildKind: options.buildKind,
            electronVersion: process.versions.electron ?? "",
            nodeVersion: process.version
          }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/windows") {
        writeJsonSafe(response, { ok: true, windows: listWindows() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/logs/runtime") {
        const tail = Number(url.searchParams.get("tail") ?? "200");
        writeJsonSafe(response, {
          ok: true,
          ...(await tailRuntimeLog(options.getRuntimeLogFilePath(), tail))
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/renderer/execute") {
        const body = (await readJsonBody(request)) as RendererDebugExecuteRequest;
        writeJsonSafe(response, await executeRendererCommand(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/main/execute") {
        const body = (await readJsonBody(request)) as MainDebugExecuteRequest;
        writeJsonSafe(response, await executeMainCommand(body, options.getRuntimeLogFilePath()));
        return;
      }

      writeJsonSafe(response, { error: "Not found." }, { status: 404 });
    } catch (error) {
      if (isIgnorablePipeError(error) || !canWriteJsonResponse(response)) {
        return;
      }
      options.writeRuntimeLog("debug-bridge", "Request failed", {
        method: request.method,
        url: request.url,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      });
      writeJsonSafe(response, toExecutionError("Debug bridge request failed.", error), { status: 500 });
    }
  });
  server.on("clientError", (error, socket) => {
    if (isIgnorablePipeError(error)) {
      socket.destroy();
      return;
    }
    options.writeRuntimeLog("debug-bridge", "Client error", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    });
    if (!socket.destroyed) {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine live debug server port."));
        return;
      }
      port = address.port;
      resolve();
    });
  });

  await writeManifest();
  options.writeRuntimeLog("debug-bridge", "Live debug bridge started", {
    port,
    manifestPath: getManifestPath(options.getLogsRoot)
  });

  return {
    async refreshManifest(): Promise<void> {
      await writeManifest();
    },
    async dispose(): Promise<void> {
      await clearManifest();
      if (!server) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      options.writeRuntimeLog("debug-bridge", "Live debug bridge stopped");
      server = null;
    }
  };
}

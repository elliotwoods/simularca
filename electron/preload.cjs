const { contextBridge, ipcRenderer, webUtils } = require("electron");

function serializeReason(reason) {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack
    };
  }
  if (typeof reason === "object" && reason !== null) {
    return reason;
  }
  return {
    value: String(reason)
  };
}

window.addEventListener("error", (event) => {
  ipcRenderer.send("renderer:runtime-error", {
    type: "window.error",
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: serializeReason(event.error)
  });
});

window.addEventListener("unhandledrejection", (event) => {
  ipcRenderer.send("renderer:runtime-error", {
    type: "window.unhandledrejection",
    reason: serializeReason(event.reason)
  });
});

const api = {
  mode: "electron-rw",
  getPathForFile: (file) => {
    try {
      if (!file || typeof webUtils?.getPathForFile !== "function") {
        return null;
      }
      const filePath = webUtils.getPathForFile(file);
      return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
    } catch (_error) {
      return null;
    }
  },
  listProjects: () => ipcRenderer.invoke("projects:list"),
  listSnapshots: (projectName) => ipcRenderer.invoke("snapshots:list", projectName),
  loadDefaults: () => ipcRenderer.invoke("defaults:load"),
  saveDefaults: (pointer) => ipcRenderer.invoke("defaults:save", pointer),
  loadProjectSnapshot: (args) => ipcRenderer.invoke("project:load-snapshot", args),
  saveProjectSnapshot: (args) => ipcRenderer.invoke("project:save-snapshot", args),
  cloneProject: (args) => ipcRenderer.invoke("project:clone", args),
  deleteProject: (args) => ipcRenderer.invoke("project:delete", args),
  renameProject: (args) => ipcRenderer.invoke("project:rename", args),
  duplicateSnapshot: (args) => ipcRenderer.invoke("snapshot:duplicate", args),
  renameSnapshot: (args) => ipcRenderer.invoke("snapshot:rename", args),
  deleteSnapshot: (args) => ipcRenderer.invoke("snapshot:delete", args),
  importAsset: (args) => ipcRenderer.invoke("asset:import", args),
  importDae: (args) => ipcRenderer.invoke("asset:import-dae", args),
  transcodeHdriToKtx2: (args) => ipcRenderer.invoke("asset:transcode-hdri", args),
  deleteAsset: (args) => ipcRenderer.invoke("asset:delete", args),
  resolveAssetPath: (args) => ipcRenderer.invoke("asset:resolve-path", args),
  readAssetBytes: (args) => ipcRenderer.invoke("asset:read-bytes", args),
  openFileDialog: (args) => ipcRenderer.invoke("dialog:open-file", args),
  openSaveDialog: (args) => ipcRenderer.invoke("dialog:save-file", args),
  openDirectoryDialog: (args) => ipcRenderer.invoke("dialog:open-directory", args),
  discoverExternalPlugins: () => ipcRenderer.invoke("plugins:discover-external"),
  getGitDirtyStatus: (args) => ipcRenderer.invoke("git:dirty-status", args),
  writeClipboardImagePng: (args) => ipcRenderer.invoke("clipboard:write-image-png", args),
  renderPipeOpen: (args) => ipcRenderer.invoke("render:pipe-open", args),
  renderPipeWriteFrame: (args) => {
    const bytes = args?.framePngBytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("renderPipeWriteFrame requires Uint8Array frame bytes.");
    }
    const framePngBytes =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
    ipcRenderer.send("render:pipe-write-frame", {
      pipeId: args.pipeId,
      framePngBytes
    });
  },
  renderPipeClose: (args) => ipcRenderer.invoke("render:pipe-close", args),
  renderPipeAbort: (args) => ipcRenderer.invoke("render:pipe-abort", args),
  onRenderPipeState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("render:pipe-state", handler);
    return () => {
      ipcRenderer.removeListener("render:pipe-state", handler);
    };
  },
  renderTempInit: (args) => ipcRenderer.invoke("render:temp-init", args),
  renderTempWriteFrame: (args) => ipcRenderer.invoke("render:temp-write-frame", args),
  renderTempFinalize: (args) => ipcRenderer.invoke("render:temp-finalize", args),
  renderTempAbort: (args) => ipcRenderer.invoke("render:temp-abort", args),
  logRuntimeError: (payload) => ipcRenderer.send("renderer:runtime-error", payload),
  getWindowState: () => ipcRenderer.invoke("window:get-state"),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowSetFullscreen: (fullscreen) => ipcRenderer.invoke("window:set-fullscreen", fullscreen),
  windowClose: () => ipcRenderer.invoke("window:close"),
  showAppMenu: (args) => ipcRenderer.invoke("menu:show-app", args),
  onWindowStateChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("window:state", handler);
    return () => {
      ipcRenderer.removeListener("window:state", handler);
    };
  },
  rotoControlConnect: () => ipcRenderer.invoke("roto-control:connect"),
  rotoControlRefresh: () => ipcRenderer.invoke("roto-control:refresh"),
  rotoControlSetSerialOverride: (path) => ipcRenderer.invoke("roto-control:set-serial-override", path),
  rotoControlSetDawEmulation: (mode) => ipcRenderer.invoke("roto-control:set-daw-emulation", mode),
  rotoControlPublishBank: (bank) => ipcRenderer.invoke("roto-control:publish-bank", bank),
  onRotoControlState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("roto-control:state", handler);
    return () => {
      ipcRenderer.removeListener("roto-control:state", handler);
    };
  },
  onRotoControlInput: (listener) => {
    const handler = (_event, event) => listener(event);
    ipcRenderer.on("roto-control:input", handler);
    return () => {
      ipcRenderer.removeListener("roto-control:input", handler);
    };
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);

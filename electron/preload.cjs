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
  loadRecents: () => ipcRenderer.invoke("recents:load"),
  saveRecents: (entries) => ipcRenderer.invoke("recents:save", entries),
  removeRecent: (args) => ipcRenderer.invoke("recents:remove", args),
  locateRecent: (args) => ipcRenderer.invoke("recents:locate", args),
  loadDefaults: () => ipcRenderer.invoke("defaults:load"),
  saveDefaults: (pointer) => ipcRenderer.invoke("defaults:save", pointer),
  selectSimularcaFile: (args) => ipcRenderer.invoke("dialog:select-simularca", args ?? {}),
  selectFolder: (args) => ipcRenderer.invoke("dialog:select-folder", args ?? {}),
  getDefaultProjectsRoot: () => ipcRenderer.invoke("paths:default-projects-root"),
  createNewProject: (args) => ipcRenderer.invoke("project:create-new", args),
  openProject: (args) => ipcRenderer.invoke("project:open", args),
  saveProjectSnapshot: (args) => ipcRenderer.invoke("project:save-snapshot", args),
  loadSnapshot: (args) => ipcRenderer.invoke("snapshot:load", args),
  listSnapshots: (args) => ipcRenderer.invoke("snapshots:list", args),
  saveProjectAs: (args) => ipcRenderer.invoke("project:save-as", args),
  moveProject: (args) => ipcRenderer.invoke("project:move", args),
  renameProject: (args) => ipcRenderer.invoke("project:rename", args),
  deleteProject: (args) => ipcRenderer.invoke("project:delete", args),
  repairProjectPointer: (args) => ipcRenderer.invoke("project:repair-pointer", args),
  duplicateSnapshot: (args) => ipcRenderer.invoke("snapshot:duplicate", args),
  renameSnapshot: (args) => ipcRenderer.invoke("snapshot:rename", args),
  deleteSnapshot: (args) => ipcRenderer.invoke("snapshot:delete", args),
  detectLegacyProjects: () => ipcRenderer.invoke("migration:detect-legacy"),
  migrateLegacyProject: (args) => ipcRenderer.invoke("migration:run", args),
  writeMigrationReadme: (args) => ipcRenderer.invoke("migration:write-readme", args),
  deleteLegacyProject: (args) => ipcRenderer.invoke("migration:delete-legacy", args),
  importAsset: (args) => ipcRenderer.invoke("asset:import", args),
  writeGeneratedAsset: (args) => ipcRenderer.invoke("asset:write-generated", args),
  importDae: (args) => ipcRenderer.invoke("asset:import-dae", args),
  transcodeHdriToKtx2: (args) => ipcRenderer.invoke("asset:transcode-hdri", args),
  deleteAsset: (args) => ipcRenderer.invoke("asset:delete", args),
  resolveAssetPath: (args) => ipcRenderer.invoke("asset:resolve-path", args),
  readAssetBytes: (args) => ipcRenderer.invoke("asset:read-bytes", args),
  readProjectionCache: (args) => ipcRenderer.invoke("projection-cache:read", args),
  writeProjectionCache: (args) => ipcRenderer.invoke("projection-cache:write", args),
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
  logRuntimeStats: (payload) => ipcRenderer.send("renderer:runtime-stats", payload),
  getWindowState: () => ipcRenderer.invoke("window:get-state"),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowSetFullscreen: (fullscreen) => ipcRenderer.invoke("window:set-fullscreen", fullscreen),
  windowClose: () => ipcRenderer.invoke("window:close"),
  showAppMenu: (args) => ipcRenderer.invoke("menu:show-app", args),
  onBeforeClose: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("window:before-close", handler);
    return () => { ipcRenderer.removeListener("window:before-close", handler); };
  },
  confirmClose: (action) => ipcRenderer.invoke("window:confirm-close", action),
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
  },
  publish: {
    loadSettings: () => ipcRenderer.invoke("publish:load-settings"),
    saveSettings: (args) => ipcRenderer.invoke("publish:save-settings", args),
    listForProject: (args) => ipcRenderer.invoke("publish:list-for-project", args),
    checkViewerVersion: (args) => ipcRenderer.invoke("publish:check-viewer-version", args),
    verifyTarget: (args) => ipcRenderer.invoke("publish:verify-target", args),
    start: (args) => ipcRenderer.invoke("publish:start", args),
    cancel: (args) => ipcRenderer.invoke("publish:cancel", args),
    rollback: (args) => ipcRenderer.invoke("publish:rollback", args),
    deletePublish: (args) => ipcRenderer.invoke("publish:delete", args),
    onProgress: (listener) => {
      const handler = (_event, event) => listener(event);
      ipcRenderer.on("publish:progress", handler);
      return () => {
        ipcRenderer.removeListener("publish:progress", handler);
      };
    },
    openVercelTokens: () => ipcRenderer.invoke("publish:open-vercel-tokens"),
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", { url }),
    verifyVercelToken: (args) => ipcRenderer.invoke("publish:verify-vercel-token", args),
    saveVercelSettings: (args) => ipcRenderer.invoke("publish:save-vercel-settings", args),
    deployViewer: () => ipcRenderer.invoke("publish:deploy-viewer"),
    onViewerDeployProgress: (listener) => {
      const handler = (_event, event) => listener(event);
      ipcRenderer.on("publish:viewer-deploy-progress", handler);
      return () => {
        ipcRenderer.removeListener("publish:viewer-deploy-progress", handler);
      };
    },
    setDefaultLayout: (args) => ipcRenderer.invoke("publish:set-default-layout", args),
    setDefaultPermissions: (args) => ipcRenderer.invoke("publish:set-default-permissions", args)
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);

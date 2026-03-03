const { contextBridge, ipcRenderer } = require("electron");

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
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  loadDefaults: () => ipcRenderer.invoke("defaults:load"),
  saveDefaults: (pointer) => ipcRenderer.invoke("defaults:save", pointer),
  loadSession: (sessionName) => ipcRenderer.invoke("session:load", sessionName),
  saveSession: (sessionName, payload) => ipcRenderer.invoke("session:save", sessionName, payload),
  renameSession: (args) => ipcRenderer.invoke("session:rename", args),
  importAsset: (args) => ipcRenderer.invoke("asset:import", args),
  importGaussianSplat: (args) => ipcRenderer.invoke("asset:import-gaussian", args),
  convertGaussianAsset: (args) => ipcRenderer.invoke("asset:convert-gaussian", args),
  transcodeHdriToKtx2: (args) => ipcRenderer.invoke("asset:transcode-hdri", args),
  deleteAsset: (args) => ipcRenderer.invoke("asset:delete", args),
  resolveAssetPath: (args) => ipcRenderer.invoke("asset:resolve-path", args),
  readAssetBytes: (args) => ipcRenderer.invoke("asset:read-bytes", args),
  openFileDialog: (args) => ipcRenderer.invoke("dialog:open-file", args),
  logRuntimeError: (payload) => ipcRenderer.send("renderer:runtime-error", payload),
  getWindowState: () => ipcRenderer.invoke("window:get-state"),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  showAppMenu: (args) => ipcRenderer.invoke("menu:show-app", args),
  onWindowStateChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("window:state", handler);
    return () => {
      ipcRenderer.removeListener("window:state", handler);
    };
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);

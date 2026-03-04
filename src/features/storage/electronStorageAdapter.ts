import type { StorageAdapter } from "./storageAdapter";

export function createElectronStorageAdapter(): StorageAdapter {
  if (!window.electronAPI) {
    throw new Error("Electron API is not available.");
  }

  return {
    mode: "electron-rw",
    isReadOnly: false,
    listSessions: () => window.electronAPI!.listSessions(),
    loadDefaults: () => window.electronAPI!.loadDefaults(),
    saveDefaults: (pointer) => window.electronAPI!.saveDefaults(pointer),
    loadSession: (sessionName) => window.electronAPI!.loadSession(sessionName),
    saveSession: (sessionName, payload) => window.electronAPI!.saveSession(sessionName, payload),
    cloneSession: (previousName, nextName) => window.electronAPI!.cloneSession({ previousName, nextName }),
    renameSession: (previousName, nextName) => window.electronAPI!.renameSession({ previousName, nextName }),
    importAsset: (args) => window.electronAPI!.importAsset(args),
    importDae: (args) => window.electronAPI!.importDae(args),
    importGaussianSplat: (args) => window.electronAPI!.importGaussianSplat(args),
    convertGaussianAsset: (args) => window.electronAPI!.convertGaussianAsset(args),
    transcodeHdriToKtx2: (args) => window.electronAPI!.transcodeHdriToKtx2(args),
    deleteAsset: (args) => window.electronAPI!.deleteAsset(args),
    resolveAssetPath: (args) => window.electronAPI!.resolveAssetPath(args),
    readAssetBytes: (args) => window.electronAPI!.readAssetBytes(args)
  };
}


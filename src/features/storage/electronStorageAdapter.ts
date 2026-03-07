import type { StorageAdapter } from "./storageAdapter";

export function createElectronStorageAdapter(): StorageAdapter {
  if (!window.electronAPI) {
    throw new Error("Electron API is not available.");
  }

  return {
    mode: "electron-rw",
    isReadOnly: false,
    listProjects: () => window.electronAPI!.listProjects(),
    listSnapshots: (projectName) => window.electronAPI!.listSnapshots(projectName),
    loadDefaults: () => window.electronAPI!.loadDefaults(),
    saveDefaults: (pointer) => window.electronAPI!.saveDefaults(pointer),
    loadProjectSnapshot: (projectName, snapshotName) => window.electronAPI!.loadProjectSnapshot({ projectName, snapshotName }),
    saveProjectSnapshot: (projectName, snapshotName, payload) =>
      window.electronAPI!.saveProjectSnapshot({ projectName, snapshotName, payload }),
    cloneProject: (previousName, nextName) => window.electronAPI!.cloneProject({ previousName, nextName }),
    deleteProject: (projectName) => window.electronAPI!.deleteProject({ projectName }),
    renameProject: (previousName, nextName) => window.electronAPI!.renameProject({ previousName, nextName }),
    duplicateSnapshot: (projectName, previousName, nextName) =>
      window.electronAPI!.duplicateSnapshot({ projectName, previousName, nextName }),
    renameSnapshot: (projectName, previousName, nextName) =>
      window.electronAPI!.renameSnapshot({ projectName, previousName, nextName }),
    deleteSnapshot: (projectName, snapshotName) => window.electronAPI!.deleteSnapshot({ projectName, snapshotName }),
    importAsset: (args) => window.electronAPI!.importAsset(args),
    importDae: (args) => window.electronAPI!.importDae(args),
    transcodeHdriToKtx2: (args) => window.electronAPI!.transcodeHdriToKtx2(args),
    deleteAsset: (args) => window.electronAPI!.deleteAsset(args),
    resolveAssetPath: (args) => window.electronAPI!.resolveAssetPath(args),
    readAssetBytes: (args) => window.electronAPI!.readAssetBytes(args)
  };
}

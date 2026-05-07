import type { StorageAdapter } from "./storageAdapter";

export function createElectronStorageAdapter(): StorageAdapter {
  if (!window.electronAPI) {
    throw new Error("Electron API is not available.");
  }
  const api = window.electronAPI;

  return {
    mode: "electron-rw",
    isReadOnly: false,
    loadRecents: () => api.loadRecents(),
    saveRecents: (entries) => api.saveRecents(entries),
    removeRecent: (uuid) => api.removeRecent({ uuid }),
    locateRecent: (uuid, title) => api.locateRecent({ uuid, title }),
    loadDefaults: () => api.loadDefaults(),
    saveDefaults: (pointer) => api.saveDefaults(pointer),
    selectSimularcaFile: (title) => api.selectSimularcaFile({ title }),
    selectFolder: (args) => api.selectFolder(args),
    getDefaultProjectsRoot: () => api.getDefaultProjectsRoot(),
    createNewProject: (args) => api.createNewProject(args),
    openProject: (simularcaPath) => api.openProject({ simularcaPath }),
    saveProjectAs: (args) => api.saveProjectAs(args),
    moveProject: (args) => api.moveProject(args),
    renameProject: (args) => api.renameProject(args),
    deleteProject: (projectPath) => api.deleteProject({ projectPath }),
    repairPointer: (folderPath) => api.repairProjectPointer({ folderPath }),
    listSnapshots: (projectPath) => api.listSnapshots({ projectPath }),
    loadSnapshot: (projectPath, snapshotName) => api.loadSnapshot({ projectPath, snapshotName }),
    saveSnapshot: (projectPath, snapshotName, payload) =>
      api.saveProjectSnapshot({ projectPath, snapshotName, payload }),
    duplicateSnapshot: (projectPath, previousName, nextName) =>
      api.duplicateSnapshot({ projectPath, previousName, nextName }),
    renameSnapshot: (projectPath, previousName, nextName) =>
      api.renameSnapshot({ projectPath, previousName, nextName }),
    deleteSnapshot: (projectPath, snapshotName) => api.deleteSnapshot({ projectPath, snapshotName }),
    detectLegacyProjects: () => api.detectLegacyProjects(),
    migrateLegacyProject: (args) => api.migrateLegacyProject(args),
    writeMigrationReadme: (args) => api.writeMigrationReadme(args),
    deleteLegacyProject: (legacyName) => api.deleteLegacyProject({ legacyName }),
    importAsset: (args) => api.importAsset(args),
    writeGeneratedAsset: (args) => api.writeGeneratedAsset(args),
    importDae: (args) => api.importDae(args),
    transcodeHdriToKtx2: (args) => api.transcodeHdriToKtx2(args),
    deleteAsset: (args) => api.deleteAsset(args),
    resolveAssetPath: (args) => api.resolveAssetPath(args),
    readAssetBytes: (args) => api.readAssetBytes(args),
    readProjectionCache: (projectPath) => api.readProjectionCache({ projectPath }),
    writeProjectionCache: (projectPath, payload) => api.writeProjectionCache({ projectPath, payload })
  };
}

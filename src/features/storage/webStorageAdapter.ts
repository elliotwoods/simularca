import type { StorageAdapter } from "./storageAdapter";

const READ_ONLY_MESSAGE = "Read-only mode: this operation is not supported.";

export function createWebStorageAdapter(): StorageAdapter {
  function readOnly(): never {
    throw new Error(READ_ONLY_MESSAGE);
  }

  return {
    mode: "web-ro",
    isReadOnly: true,
    async loadRecents() {
      return [];
    },
    async saveRecents() {
      readOnly();
    },
    async removeRecent() {
      readOnly();
    },
    async locateRecent() {
      return null;
    },
    async loadDefaults() {
      return null;
    },
    async saveDefaults() {
      readOnly();
    },
    async selectSimularcaFile() {
      return null;
    },
    async selectFolder() {
      return null;
    },
    async getDefaultProjectsRoot() {
      return "";
    },
    async createNewProject() {
      readOnly();
    },
    async openProject() {
      readOnly();
    },
    async saveProjectAs() {
      readOnly();
    },
    async moveProject() {
      readOnly();
    },
    async renameProject() {
      readOnly();
    },
    async deleteProject() {
      readOnly();
    },
    async repairPointer() {
      readOnly();
    },
    async listSnapshots() {
      return [];
    },
    async loadSnapshot() {
      return "{}";
    },
    async saveSnapshot() {
      readOnly();
    },
    async duplicateSnapshot() {
      readOnly();
    },
    async renameSnapshot() {
      readOnly();
    },
    async deleteSnapshot() {
      readOnly();
    },
    async detectLegacyProjects() {
      return [];
    },
    async migrateLegacyProject() {
      readOnly();
    },
    async writeMigrationReadme() {
      readOnly();
    },
    async deleteLegacyProject() {
      readOnly();
    },
    async importAsset() {
      readOnly();
    },
    async writeGeneratedAsset() {
      readOnly();
    },
    async importDae() {
      readOnly();
    },
    async transcodeHdriToKtx2() {
      readOnly();
    },
    async deleteAsset() {
      readOnly();
    },
    async resolveAssetPath({ projectUuid, relativePath }) {
      return `simularca-asset://${encodeURIComponent(projectUuid)}/${relativePath}`;
    },
    async readAssetBytes() {
      readOnly();
    },
    async readProjectionCache() {
      return null;
    },
    async writeProjectionCache() {
      // Web mode has no filesystem; silently no-op so the renderer code path stays uniform.
    }
  };
}

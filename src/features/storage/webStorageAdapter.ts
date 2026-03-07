import type { ProjectAssetRef, ProjectSnapshotListEntry } from "@/types/ipc";
import type { StorageAdapter } from "./storageAdapter";

const DEFAULTS_PATH = "/sessions/defaults.json";

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}.`);
  }
  return response.text();
}

export function createWebStorageAdapter(): StorageAdapter {
  return {
    mode: "web-ro",
    isReadOnly: true,
    async listProjects() {
      const defaults = await this.loadDefaults();
      return [defaults.defaultProjectName];
    },
    async listSnapshots(_projectName) {
      const defaults = await this.loadDefaults();
      return [{ name: defaults.defaultSnapshotName, updatedAtIso: null }] satisfies ProjectSnapshotListEntry[];
    },
    async loadDefaults() {
      const raw = await fetchText(DEFAULTS_PATH);
      const parsed = JSON.parse(raw) as { defaultProjectName?: string; defaultSnapshotName?: string; defaultSessionName?: string };
      return {
        defaultProjectName: parsed.defaultProjectName ?? parsed.defaultSessionName ?? "demo",
        defaultSnapshotName: parsed.defaultSnapshotName ?? "main"
      };
    },
    async saveDefaults() {
      throw new Error("Read-only mode: defaults cannot be saved.");
    },
    async loadProjectSnapshot(projectName, snapshotName) {
      if (snapshotName !== "main") {
        try {
          return await fetchText(`/sessions/${projectName}/snapshots/${snapshotName}.json`);
        } catch {
          // Fall back to legacy single-snapshot layout.
        }
      }
      return await fetchText(`/sessions/${projectName}/session.json`);
    },
    async saveProjectSnapshot() {
      throw new Error("Read-only mode: project cannot be saved.");
    },
    async cloneProject() {
      throw new Error("Read-only mode: projects cannot be cloned.");
    },
    async deleteProject() {
      throw new Error("Read-only mode: projects cannot be deleted.");
    },
    async renameProject() {
      throw new Error("Read-only mode: projects cannot be renamed.");
    },
    async duplicateSnapshot() {
      throw new Error("Read-only mode: snapshots cannot be duplicated.");
    },
    async renameSnapshot() {
      throw new Error("Read-only mode: snapshots cannot be renamed.");
    },
    async deleteSnapshot() {
      throw new Error("Read-only mode: snapshots cannot be deleted.");
    },
    async importAsset(_args: {
      projectName: string;
      sourcePath: string;
      kind: ProjectAssetRef["kind"];
    }) {
      throw new Error("Read-only mode: assets cannot be imported.");
    },
    async importDae() {
      throw new Error("Read-only mode: DAE assets cannot be imported.");
    },
    async transcodeHdriToKtx2() {
      throw new Error("Read-only mode: HDRI transcoding is disabled.");
    },
    async deleteAsset() {
      throw new Error("Read-only mode: assets cannot be deleted.");
    },
    resolveAssetPath: async ({ projectName, relativePath }) => `/sessions/${projectName}/${relativePath}`,
    async readAssetBytes({ projectName, relativePath }) {
      const response = await fetch(`/sessions/${projectName}/${relativePath}`);
      if (!response.ok) {
        throw new Error(`Unable to fetch asset bytes: ${relativePath}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

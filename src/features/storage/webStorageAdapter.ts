import type { SessionAssetRef } from "@/types/ipc";
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
    async listSessions() {
      const defaults = await this.loadDefaults();
      return [defaults.defaultSessionName];
    },
    async loadDefaults() {
      const raw = await fetchText(DEFAULTS_PATH);
      return JSON.parse(raw) as { defaultSessionName: string };
    },
    async saveDefaults() {
      throw new Error("Read-only mode: defaults cannot be saved.");
    },
    loadSession: async (sessionName) => fetchText(`/sessions/${sessionName}/session.json`),
    async saveSession() {
      throw new Error("Read-only mode: session cannot be saved.");
    },
    async renameSession() {
      throw new Error("Read-only mode: sessions cannot be renamed.");
    },
    async importAsset(_args: {
      sessionName: string;
      sourcePath: string;
      kind: SessionAssetRef["kind"];
    }) {
      throw new Error("Read-only mode: assets cannot be imported.");
    },
    async importGaussianSplat() {
      throw new Error("Read-only mode: Gaussian splats cannot be imported.");
    },
    async convertGaussianAsset() {
      throw new Error("Read-only mode: Gaussian splats cannot be converted.");
    },
    async transcodeHdriToKtx2() {
      throw new Error("Read-only mode: HDRI transcoding is disabled.");
    },
    async deleteAsset() {
      throw new Error("Read-only mode: assets cannot be deleted.");
    },
    resolveAssetPath: async ({ sessionName, relativePath }) => `/sessions/${sessionName}/${relativePath}`,
    async readAssetBytes({ sessionName, relativePath }) {
      const response = await fetch(`/sessions/${sessionName}/${relativePath}`);
      if (!response.ok) {
        throw new Error(`Unable to fetch asset bytes: ${relativePath}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}


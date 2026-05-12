import type { StorageAdapter } from "./storageAdapter";
import type {
  OpenProjectResult,
  ProjectIdentity,
  ProjectSnapshotListEntry
} from "@/types/ipc";
import {
  buildAssetKey,
  type PublishManifest
} from "@/features/publish/publishManifestSchema";

const READ_ONLY_MESSAGE = "Read-only mode: this operation is not supported.";

/**
 * Identity-bridging contract (asserted by `createViewerKernel`):
 *   `activeProject.path === manifest.project.uuid`
 *
 * `StorageAdapter.resolveAssetPath` is keyed by `projectUuid`, while
 * `readAssetBytes` is keyed by `projectPath`. In Electron, a server-side
 * lookup table bridges them. The viewer has no filesystem, so we simply set
 * `path = uuid` and both code paths converge.
 *
 * If the kernel is bootstrapped any other way, asset resolution will fail
 * with a "key not found" error. The invariant is asserted at boot to crash
 * loudly rather than producing 404s deep in the render pipeline.
 */
export interface WebStorageAdapterOptions {
  manifest: PublishManifest;
  /** No trailing slash. e.g. `https://my-bucket.r2.dev` or a custom domain. */
  bucketBaseUrl: string;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildAbsoluteUrl(base: string, bucketRelative: string): string {
  const normalisedBase = trimTrailingSlash(base);
  const normalisedRelative = bucketRelative.startsWith("/")
    ? bucketRelative.slice(1)
    : bucketRelative;
  return `${normalisedBase}/${normalisedRelative}`;
}

function manifestToProjectIdentity(manifest: PublishManifest): ProjectIdentity {
  // `path = uuid` is the identity-bridging contract documented above.
  return {
    uuid: manifest.project.uuid,
    path: manifest.project.uuid,
    name: manifest.project.name
  };
}

function manifestToSnapshotList(manifest: PublishManifest): ProjectSnapshotListEntry[] {
  return manifest.snapshots.map((entry) => ({
    name: entry.name,
    updatedAtIso: manifest.publishedAtIso
  }));
}

function pickDefaultSnapshotName(manifest: PublishManifest): string {
  const explicit = manifest.snapshots.find((entry) => entry.default === true);
  return explicit?.name ?? manifest.snapshots[0]?.name ?? "main";
}

export function createWebStorageAdapter(
  options: WebStorageAdapterOptions
): StorageAdapter {
  const { manifest, bucketBaseUrl } = options;
  const baseUrl = trimTrailingSlash(bucketBaseUrl);

  function readOnly(): never {
    throw new Error(READ_ONLY_MESSAGE);
  }

  function snapshotEntryByName(name: string): { url: string; schemaVersion: number } | null {
    const entry = manifest.snapshots.find((candidate) => candidate.name === name);
    return entry ? { url: entry.url, schemaVersion: entry.schemaVersion } : null;
  }

  function assetUrlOrThrow(projectUuid: string, relativePath: string): string {
    const key = buildAssetKey(projectUuid, relativePath);
    const bucketRelative = manifest.assets[key];
    if (!bucketRelative) {
      throw new Error(
        `Asset not found in publish manifest: ${key}. The publish manifest may be missing this asset, or the projectUuid does not match (identity-bridging invariant).`
      );
    }
    return buildAbsoluteUrl(baseUrl, bucketRelative);
  }

  return {
    mode: "web-ro",
    isReadOnly: true,

    // Recents/defaults: silent no-ops in viewer (no editor UI calls them, and
    // ProjectService.openProject pipes through promoteAndSetDefault on success).
    async loadRecents() {
      return [];
    },
    async saveRecents() {
      // no-op in viewer; the call comes from ProjectService.promoteAndSetDefault.
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
      // no-op in viewer; same reason as saveRecents above.
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
    async openProject(simularcaPath: string): Promise<OpenProjectResult> {
      // The "path" here is the projectUuid by the identity-bridging contract.
      if (simularcaPath !== manifest.project.uuid) {
        throw new Error(
          `Web viewer can only open the published project (${manifest.project.uuid}); requested ${simularcaPath}.`
        );
      }
      return {
        identity: manifestToProjectIdentity(manifest),
        snapshots: manifestToSnapshotList(manifest),
        lastSnapshotName: pickDefaultSnapshotName(manifest)
      };
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
      return manifestToSnapshotList(manifest);
    },
    async loadSnapshot(_projectPath: string, snapshotName: string): Promise<string> {
      const entry = snapshotEntryByName(snapshotName);
      if (!entry) {
        throw new Error(`Snapshot "${snapshotName}" is not in the publish manifest.`);
      }
      const url = buildAbsoluteUrl(baseUrl, entry.url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch snapshot ${snapshotName}: ${String(response.status)} ${response.statusText}`);
      }
      return await response.text();
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
      return assetUrlOrThrow(projectUuid, relativePath);
    },
    async readAssetBytes({ projectPath, relativePath }) {
      // `projectPath === projectUuid` per the identity-bridging contract above.
      const url = assetUrlOrThrow(projectPath, relativePath);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch asset ${relativePath}: ${String(response.status)} ${response.statusText}`
        );
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    },

    async readProjectionCache() {
      return null;
    },
    async writeProjectionCache() {
      // Web mode has no filesystem; silently no-op so the renderer code path stays uniform.
    }
  };
}

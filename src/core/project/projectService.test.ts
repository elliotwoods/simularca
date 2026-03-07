import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "@/core/defaults";
import { createAppStore } from "@/core/store/appStore";
import { ProjectService } from "@/core/project/projectService";
import { serializeProjectSnapshot, parseProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import { PROJECT_SCHEMA_VERSION, type ProjectSnapshotManifest } from "@/core/types";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { ProjectAssetRef } from "@/types/ipc";

function buildManifest(projectName: string, snapshotName = "main", assets: ProjectAssetRef[] = []): ProjectSnapshotManifest {
  const state = createInitialState("electron-rw", projectName, snapshotName);
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appMode: "electron-rw",
    projectName,
    snapshotName,
    createdAtIso: "2026-03-03T00:00:00.000Z",
    updatedAtIso: "2026-03-03T00:00:00.000Z",
    scene: state.scene,
    actors: state.actors,
    components: state.components,
    camera: state.camera,
    cameraBookmarks: state.cameraBookmarks,
    time: state.time,
    materials: state.materials,
    assets
  };
}

function createStorageMocks(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    mode: "electron-rw",
    isReadOnly: false,
    listProjects: vi.fn(async () => ["demo"]),
    listSnapshots: vi.fn(async () => [{ name: "main", updatedAtIso: "2026-03-03T00:00:00.000Z" }]),
    loadDefaults: vi.fn(async () => ({ defaultProjectName: "demo", defaultSnapshotName: "main" })),
    saveDefaults: vi.fn(async () => {}),
    loadProjectSnapshot: vi.fn(async () => "{}"),
    saveProjectSnapshot: vi.fn(async () => {}),
    cloneProject: vi.fn(async () => {}),
    renameProject: vi.fn(async () => {}),
    duplicateSnapshot: vi.fn(async () => {}),
    renameSnapshot: vi.fn(async () => {}),
    deleteSnapshot: vi.fn(async () => {}),
    importAsset: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    importDae: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    importGaussianSplat: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    convertGaussianAsset: vi.fn(
      async (args: { projectName: string; assetId: string; relativePath: string; sourceFileName: string }) =>
        ({
          id: args.assetId,
          kind: "gaussian-splat",
          encoding: "splatbin-v1",
          relativePath: "assets/gaussian-splat/converted.splatbin",
          sourceFileName: args.sourceFileName,
          byteSize: 1024
        }) satisfies ProjectAssetRef
    ),
    transcodeHdriToKtx2: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    deleteAsset: vi.fn(async () => {}),
    resolveAssetPath: vi.fn(async ({ projectName, relativePath }) => `/sessions/${projectName}/${relativePath}`),
    readAssetBytes: vi.fn(async () => new Uint8Array()),
    ...overrides
  };
}

describe("project service", () => {
  it("uses requested project and snapshot names as canonical identity", async () => {
    const storage = createStorageMocks({
      loadProjectSnapshot: vi.fn(async () => serializeProjectSnapshot(buildManifest("old-name", "draft")))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.loadProject("new-name", "main");

    expect(store.getState().state.activeProjectName).toBe("new-name");
    expect(store.getState().state.activeSnapshotName).toBe("main");
    expect(storage.saveProjectSnapshot).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(storage.saveProjectSnapshot).mock.calls[0];
    expect(saved?.[0]).toBe("new-name");
    expect(saved?.[1]).toBe("main");
    const payload = saved?.[2] ?? "";
    expect(parseProjectSnapshot(payload).projectName).toBe("new-name");
    expect(parseProjectSnapshot(payload).snapshotName).toBe("main");
  });

  it("runs gaussian asset migration against canonical requested project name", async () => {
    const legacyAsset: ProjectAssetRef = {
      id: "legacy-asset-1",
      kind: "gaussian-splat",
      encoding: "raw",
      relativePath: "assets/gaussian-splat/legacy.ply",
      sourceFileName: "legacy.ply",
      byteSize: 42
    };
    const storage = createStorageMocks({
      loadProjectSnapshot: vi.fn(async () => serializeProjectSnapshot(buildManifest("old-name", "main", [legacyAsset])))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.loadProject("new-name", "main");

    expect(storage.convertGaussianAsset).toHaveBeenCalledTimes(1);
    const args = vi.mocked(storage.convertGaussianAsset).mock.calls[0]?.[0];
    expect(args?.projectName).toBe("new-name");
  });

  it("auto-saves before and after active-project rename", async () => {
    const events: string[] = [];
    const storage = createStorageMocks({
      saveProjectSnapshot: vi.fn(async (projectName: string, snapshotName: string) => {
        events.push(`save:${projectName}/${snapshotName}`);
      }),
      renameProject: vi.fn(async (previousName: string, nextName: string) => {
        events.push(`rename:${previousName}->${nextName}`);
      }),
      saveDefaults: vi.fn(async ({ defaultProjectName, defaultSnapshotName }) => {
        events.push(`defaults:${defaultProjectName}/${defaultSnapshotName}`);
      })
    });
    const store = createAppStore("electron-rw");
    store.getState().actions.setDirty(true);
    const service = new ProjectService(storage, store);

    await service.renameProject("demo", "renamed");

    expect(events).toEqual(["save:demo/main", "rename:demo->renamed", "defaults:renamed/main", "save:renamed/main"]);
    expect(store.getState().state.activeProjectName).toBe("renamed");
    expect(store.getState().state.dirty).toBe(false);
  });

  it("skips writes on no-op project rename", async () => {
    const storage = createStorageMocks();
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.renameProject("demo", "demo");

    expect(storage.renameProject).not.toHaveBeenCalled();
    expect(storage.saveDefaults).not.toHaveBeenCalled();
    expect(storage.saveProjectSnapshot).not.toHaveBeenCalled();
  });

  it("trims the target project name before renaming", async () => {
    const storage = createStorageMocks();
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.renameProject("demo", "  renamed  ");

    expect(storage.renameProject).toHaveBeenCalledWith("demo", "renamed");
    expect(store.getState().state.activeProjectName).toBe("renamed");
  });

  it("does not rewrite snapshot file when manifest identity already matches and no migration happens", async () => {
    const storage = createStorageMocks({
      loadProjectSnapshot: vi.fn(async () => serializeProjectSnapshot(buildManifest("demo", "main")))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.loadProject("demo", "main");

    expect(storage.saveProjectSnapshot).not.toHaveBeenCalled();
    expect(storage.convertGaussianAsset).not.toHaveBeenCalled();
  });

  it("can set defaults for a specific snapshot without loading it first", async () => {
    const storage = createStorageMocks();
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.setDefaultSnapshot("lighting-pass", "demo");

    expect(storage.saveDefaults).toHaveBeenCalledWith({
      defaultProjectName: "demo",
      defaultSnapshotName: "lighting-pass"
    });
  });

  it("trims the target snapshot name before renaming", async () => {
    const storage = createStorageMocks();
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.renameSnapshot("main", "  draft-2  ");

    expect(storage.renameSnapshot).toHaveBeenCalledWith("demo", "main", "draft-2");
    expect(store.getState().state.activeSnapshotName).toBe("draft-2");
  });
});

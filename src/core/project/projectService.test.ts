import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "@/core/defaults";
import { createAppStore } from "@/core/store/appStore";
import { ProjectService } from "@/core/project/projectService";
import { serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import { PROJECT_SCHEMA_VERSION, type ProjectSnapshotManifest } from "@/core/types";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { ProjectAssetRef, ProjectIdentity } from "@/types/ipc";

function buildManifest(projectName: string, snapshotName = "main", assets: ProjectAssetRef[] = []): ProjectSnapshotManifest {
  const identity: ProjectIdentity = { uuid: `uuid-${projectName}`, path: `/p/${projectName}.simularca`, name: projectName };
  const state = createInitialState("electron-rw", identity, snapshotName);
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
    lastPerspectiveCamera: state.lastPerspectiveCamera,
    time: state.time,
    pluginViews: {},
    pluginsEnabled: {},
    materials: state.materials,
    assets
  };
}

function makeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  const base: StorageAdapter = {
    mode: "electron-rw",
    isReadOnly: false,
    loadRecents: vi.fn(async () => []),
    saveRecents: vi.fn(async () => {}),
    removeRecent: vi.fn(async () => {}),
    locateRecent: vi.fn(async () => null),
    loadDefaults: vi.fn(async () => null),
    saveDefaults: vi.fn(async () => {}),
    selectSimularcaFile: vi.fn(async () => null),
    selectFolder: vi.fn(async () => null),
    getDefaultProjectsRoot: vi.fn(async () => "/Documents/Simularca Projects"),
    createNewProject: vi.fn(async ({ projectName }) => ({
      uuid: `uuid-${projectName}`,
      path: `/p/${projectName}.simularca`,
      name: projectName
    })),
    openProject: vi.fn(async (simularcaPath) => ({
      identity: { uuid: `uuid-${simularcaPath}`, path: simularcaPath, name: "demo" },
      snapshots: [{ name: "main", updatedAtIso: null }],
      lastSnapshotName: null
    })),
    saveProjectAs: vi.fn(async ({ newProjectName }) => ({
      uuid: `uuid-fresh-${newProjectName}`,
      path: `/p/${newProjectName}.simularca`,
      name: newProjectName
    })),
    moveProject: vi.fn(async ({ newParentFolder }) => ({
      uuid: "uuid-moved",
      path: `${newParentFolder}/x.simularca`,
      name: "x"
    })),
    renameProject: vi.fn(async ({ newProjectName }) => ({
      uuid: "uuid-renamed",
      path: `/p/${newProjectName}.simularca`,
      name: newProjectName
    })),
    deleteProject: vi.fn(async () => {}),
    repairPointer: vi.fn(async () => ({ uuid: "uuid-repaired", path: "/p/x.simularca", name: "x" })),
    listSnapshots: vi.fn(async () => [{ name: "main", updatedAtIso: null }]),
    loadSnapshot: vi.fn(async () => "{}"),
    saveSnapshot: vi.fn(async () => {}),
    duplicateSnapshot: vi.fn(async () => {}),
    renameSnapshot: vi.fn(async () => {}),
    deleteSnapshot: vi.fn(async () => {}),
    detectLegacyProjects: vi.fn(async () => []),
    migrateLegacyProject: vi.fn(async () => ({ uuid: "u", path: "/p/x.simularca", name: "x" })),
    writeMigrationReadme: vi.fn(async () => {}),
    deleteLegacyProject: vi.fn(async () => {}),
    importAsset: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    writeGeneratedAsset: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    importDae: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    transcodeHdriToKtx2: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    deleteAsset: vi.fn(async () => {}),
    resolveAssetPath: vi.fn(async ({ projectUuid, relativePath }) => `simularca-asset://${projectUuid}/${relativePath}`),
    readAssetBytes: vi.fn(async () => new Uint8Array()),
    readProjectionCache: vi.fn(async () => null),
    writeProjectionCache: vi.fn(async () => {})
  };
  return { ...base, ...overrides };
}

describe("ProjectService", () => {
  it("openProject hydrates state and promotes the project in recents/defaults", async () => {
    const storage = makeStorage({
      openProject: vi.fn(async (simularcaPath) => ({
        identity: { uuid: "u-demo", path: simularcaPath, name: "demo" },
        snapshots: [{ name: "main", updatedAtIso: null }],
        lastSnapshotName: null
      }))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.openProject("/p/demo.simularca");

    const state = store.getState().state;
    expect(state.activeProject).toEqual({ uuid: "u-demo", path: "/p/demo.simularca", name: "demo" });
    expect(state.activeSnapshotName).toBe("main");
    expect(storage.saveRecents).toHaveBeenCalled();
    expect(storage.saveDefaults).toHaveBeenCalledWith({
      uuid: "u-demo",
      path: "/p/demo.simularca",
      lastSnapshotName: "main"
    });
  });

  it("loadDefaultProject falls through recents when defaults fail to open", async () => {
    const failingPath = "/missing/x.simularca";
    const goodPath = "/p/y.simularca";
    const openProject = vi.fn(async (p: string) => {
      if (p === failingPath) {
        throw new Error("not found");
      }
      return {
        identity: { uuid: "u-y", path: p, name: "y" },
        snapshots: [{ name: "main", updatedAtIso: null }],
        lastSnapshotName: null
      };
    });
    const storage = makeStorage({
      loadDefaults: vi.fn(async () => ({ uuid: "u-x", path: failingPath, lastSnapshotName: null })),
      loadRecents: vi.fn(async () => [
        { uuid: "u-y", path: goodPath, cachedName: "y", lastOpenedAtIso: "2026-03-03", lastSnapshotName: null }
      ]),
      openProject
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.loadDefaultProject();

    expect(store.getState().state.activeProject?.path).toBe(goodPath);
  });

  it("loadDefaultProject leaves activeProject null when nothing resolves", async () => {
    const storage = makeStorage({
      loadDefaults: vi.fn(async () => null),
      loadRecents: vi.fn(async () => [])
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);

    await service.loadDefaultProject();

    expect(store.getState().state.activeProject).toBeNull();
  });

  it("renameProject preserves uuid via storage and updates active project", async () => {
    const storage = makeStorage({
      openProject: vi.fn(async (p) => ({
        identity: { uuid: "u-orig", path: p, name: "demo" },
        snapshots: [{ name: "main", updatedAtIso: null }],
        lastSnapshotName: null
      })),
      renameProject: vi.fn(async ({ newProjectName }) => ({
        uuid: "u-orig",
        path: `/p/${newProjectName}.simularca`,
        name: newProjectName
      }))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);
    await service.openProject("/p/demo.simularca");

    await service.renameProject("renamed");

    expect(store.getState().state.activeProject?.uuid).toBe("u-orig");
    expect(store.getState().state.activeProject?.name).toBe("renamed");
  });

  it("saveProjectAs swaps to a new identity (new uuid) and persists defaults", async () => {
    const storage = makeStorage({
      openProject: vi.fn(async (p) => ({
        identity: { uuid: "u-orig", path: p, name: "demo" },
        snapshots: [{ name: "main", updatedAtIso: null }],
        lastSnapshotName: null
      })),
      saveProjectAs: vi.fn(async ({ newProjectName }) => ({
        uuid: "u-fresh",
        path: `/q/${newProjectName}.simularca`,
        name: newProjectName
      }))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);
    await service.openProject("/p/demo.simularca");

    await service.saveProjectAs({ newParentFolder: "/q", newProjectName: "demo-copy" });

    const state = store.getState().state;
    expect(state.activeProject?.uuid).toBe("u-fresh");
    expect(state.activeProject?.name).toBe("demo-copy");
  });

  it("blocks deleting the last remaining snapshot", async () => {
    const storage = makeStorage({
      openProject: vi.fn(async (p) => ({
        identity: { uuid: "u-x", path: p, name: "demo" },
        snapshots: [{ name: "main", updatedAtIso: null }],
        lastSnapshotName: null
      })),
      listSnapshots: vi.fn(async () => [{ name: "main", updatedAtIso: null }])
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);
    await service.openProject("/p/demo.simularca");

    await expect(service.deleteSnapshot("main")).rejects.toThrow("Cannot delete the last remaining snapshot.");
  });

  it("loadSnapshot rehydrates from the named snapshot via storage", async () => {
    const fakePayload = serializeProjectSnapshot(buildManifest("demo", "draft"));
    const storage = makeStorage({
      openProject: vi.fn(async (p) => ({
        identity: { uuid: "u-x", path: p, name: "demo" },
        snapshots: [
          { name: "main", updatedAtIso: null },
          { name: "draft", updatedAtIso: null }
        ],
        lastSnapshotName: null
      })),
      loadSnapshot: vi.fn(async (_projectPath, snapshotName) => (snapshotName === "draft" ? fakePayload : "{}"))
    });
    const store = createAppStore("electron-rw");
    const service = new ProjectService(storage, store);
    await service.openProject("/p/demo.simularca");

    await service.loadSnapshot("draft");

    expect(store.getState().state.activeSnapshotName).toBe("draft");
  });
});

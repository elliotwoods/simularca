import { describe, expect, it, vi } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import type { FileParameterDefinition } from "@/core/types";
import { importFileAsActor } from "@/features/imports/actorFileImport";

const fileDefinition: FileParameterDefinition = {
  key: "assetId",
  label: "Asset",
  type: "file",
  accept: [".obj"],
  import: {
    mode: "import-asset",
    kind: "generic"
  }
};

const descriptor = {
  id: "actor.mesh",
  kind: "actor",
  schema: {
    id: "actor.mesh",
    title: "Mesh",
    params: [fileDefinition]
  },
  spawn: {
    actorType: "mesh",
    label: "Mesh",
    description: "Mesh actor",
    iconGlyph: "MS",
    fileExtensions: [".obj"]
  }
};

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {
      mode: "electron-rw",
      importAsset: vi.fn(async () => ({
        id: "asset-imported",
        kind: "generic",
        name: "Imported asset",
        path: "assets/imported.obj"
      }))
    } as unknown as AppKernel["storage"],
    projectService: {
      queueAutosave: vi.fn()
    } as unknown as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: {
      listPlugins: () => []
    } as unknown as AppKernel["pluginApi"],
    descriptorRegistry: {
      get: (id: string) => (id === descriptor.id ? descriptor : null),
      listByKind: (kind: string) => (kind === "actor" ? [descriptor] : [])
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"]
  };
}

describe("importFileAsActor", () => {
  it("uses the filename stem as the new actor name", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\tree.obj",
      fileName: "tree.obj",
      projectName: "demo"
    });

    const actor = kernel.store.getState().state.actors[actorId];
    expect(actor?.name).toBe("tree");
    expect(actor?.params.assetId).toBe("asset-imported");
  });

  it("keeps only the final extension out of multi-dot filenames", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\site.model.v2.obj",
      fileName: "site.model.v2.obj",
      projectName: "demo"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe("site.model.v2");
  });

  it("preserves names without an extension", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\README",
      fileName: "README",
      projectName: "demo"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe("README");
  });

  it("does not collapse dotfile-style names to empty actor names", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\.env",
      fileName: ".env",
      projectName: "demo"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe(".env");
  });

  it("uses existing store uniqueness rules when stems collide", async () => {
    const kernel = createKernelStub();

    const firstId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\Tree.obj",
      fileName: "Tree.obj",
      projectName: "demo"
    });
    const secondId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\Tree.fbx.obj",
      fileName: "Tree.obj",
      projectName: "demo"
    });

    expect(kernel.store.getState().state.actors[firstId]?.name).toBe("Tree");
    expect(kernel.store.getState().state.actors[secondId]?.name).toBe("Tree2");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import type { FileParameterDefinition } from "@/core/types";
import {
  type ActorFileImportOption,
  importFileAsActor,
  importFileIntoActor,
  resolveNewActorFileDropAction,
  resolveSelectedActorFileImportTarget
} from "@/features/imports/actorFileImport";
import { ActorProfilingService } from "@/render/profiling";

const fileDefinition: FileParameterDefinition = {
  key: "assetId",
  label: "Asset",
  type: "file",
  accept: [".obj"],
  clearsParams: ["materialSlots"],
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

const importOption: ActorFileImportOption = {
  descriptorId: "actor.mesh",
  actorType: "mesh",
  label: "Mesh",
  description: "Mesh actor",
  iconGlyph: "MS",
  fileExtensions: [".obj"],
  fileDefinition
};

const multiFileDescriptor = {
  id: "actor.multi",
  kind: "actor",
  schema: {
    id: "actor.multi",
    title: "Multi File",
    params: [
      fileDefinition,
      {
        key: "secondaryAssetId",
        label: "Secondary Asset",
        type: "file",
        accept: [".mtl"],
        import: {
          mode: "import-asset",
          kind: "generic"
        }
      } satisfies FileParameterDefinition
    ]
  },
  spawn: {
    actorType: "plugin",
    pluginType: "multi-file",
    label: "Multi File",
    description: "Actor with multiple file params",
    iconGlyph: "MF",
    fileExtensions: [".obj", ".mtl"]
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
      })),
      importDae: vi.fn(async () => ({
        asset: {
          id: "asset-dae",
          kind: "generic",
          name: "Imported DAE",
          path: "assets/imported.dae"
        },
        imageAssets: [],
        materialDefs: []
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
      get: (id: string) => {
        if (id === descriptor.id) {
          return descriptor;
        }
        if (id === multiFileDescriptor.id) {
          return multiFileDescriptor;
        }
        return null;
      },
      listByKind: (kind: string) => (kind === "actor" ? [descriptor, multiFileDescriptor] : [])
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("importFileAsActor", () => {
  it("uses the filename stem as the new actor name", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\tree.obj",
      fileName: "tree.obj",
      projectPath: "/p/demo.simularca"
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
      projectPath: "/p/demo.simularca"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe("site.model.v2");
  });

  it("preserves names without an extension", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\README",
      fileName: "README",
      projectPath: "/p/demo.simularca"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe("README");
  });

  it("does not collapse dotfile-style names to empty actor names", async () => {
    const kernel = createKernelStub();

    const actorId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\.env",
      fileName: ".env",
      projectPath: "/p/demo.simularca"
    });

    expect(kernel.store.getState().state.actors[actorId]?.name).toBe(".env");
  });

  it("uses existing store uniqueness rules when stems collide", async () => {
    const kernel = createKernelStub();

    const firstId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\Tree.obj",
      fileName: "Tree.obj",
      projectPath: "/p/demo.simularca"
    });
    const secondId = await importFileAsActor(kernel, {
      descriptorId: "actor.mesh",
      sourcePath: "C:\\imports\\Tree.fbx.obj",
      fileName: "Tree.obj",
      projectPath: "/p/demo.simularca"
    });

    expect(kernel.store.getState().state.actors[firstId]?.name).toBe("Tree");
    expect(kernel.store.getState().state.actors[secondId]?.name).toBe("Tree2");
  });

  it("resolves direct-vs-picker behavior from matching actor options", () => {
    const none = resolveNewActorFileDropAction([]);
    const single = resolveNewActorFileDropAction([importOption]);
    const multiple = resolveNewActorFileDropAction([
      importOption,
      {
        descriptorId: "actor.alt",
        actorType: "mesh",
        label: "Alt Mesh",
        description: "Alt",
        iconGlyph: "AM",
        fileExtensions: [".obj"],
        fileDefinition
      }
    ]);

    expect(none.kind).toBe("none");
    expect(single).toEqual({ kind: "direct", descriptorId: "actor.mesh" });
    expect(multiple.kind).toBe("choose");
  });

  it("resolves a selected actor replacement target for a single selected actor with one file parameter", () => {
    const kernel = createKernelStub();
    const actorId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "mesh",
      name: "Selected mesh",
      select: false
    });

    const target = resolveSelectedActorFileImportTarget(kernel, {
      actors: kernel.store.getState().state.actors,
      selection: [{ kind: "actor", id: actorId }]
    });

    expect(target?.actorId).toBe(actorId);
    expect(target?.actorName).toBe("Selected mesh");
    expect(target?.fileDefinition.key).toBe("assetId");
  });

  it("does not gate selected actor replacement on the dragged file extension", () => {
    const kernel = createKernelStub();
    const actorId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "mesh",
      name: "Selected mesh",
      select: false
    });

    const target = resolveSelectedActorFileImportTarget(kernel, {
      actors: kernel.store.getState().state.actors,
      selection: [{ kind: "actor", id: actorId }]
    });

    expect(target?.actorId).toBe(actorId);
    expect(target?.fileDefinition.accept).toEqual([".obj"]);
  });

  it("does not expose a replacement target when the selected actor has multiple file parameters", () => {
    const kernel = createKernelStub();
    const actorId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "plugin",
      pluginType: "multi-file",
      name: "Multi file actor",
      select: false
    });

    const target = resolveSelectedActorFileImportTarget(kernel, {
      actors: kernel.store.getState().state.actors,
      selection: [{ kind: "actor", id: actorId }]
    });

    expect(target).toBeNull();
  });

  it("imports into an existing actor and applies clearsParams", async () => {
    const kernel = createKernelStub();
    const actorId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "mesh",
      name: "Selected mesh",
      select: false
    });
    kernel.store.getState().actions.updateActorParams(actorId, {
      materialSlots: { existing: "old-material" }
    });

    const imported = await importFileIntoActor(kernel, {
      actorId,
      definition: fileDefinition,
      sourcePath: "C:\\imports\\tree.obj",
      projectPath: "/p/demo.simularca"
    });

    const actor = kernel.store.getState().state.actors[actorId];
    expect(imported.asset.id).toBe("asset-imported");
    expect(actor?.params.assetId).toBe("asset-imported");
    expect(actor?.params.materialSlots).toBeNull();
  });
});



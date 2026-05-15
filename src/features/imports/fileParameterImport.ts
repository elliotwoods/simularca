import type { AppKernel } from "@/app/kernel";
import type { FileParameterDefinition, Material } from "@/core/types";
import { importHdriToKtx2 } from "@/features/imports/hdriImport";
import type { ProjectAssetRef } from "@/types/ipc";

function appendAsset(kernel: AppKernel, asset: ProjectAssetRef): void {
  kernel.store.setState((store) => ({
    ...store,
    state: {
      ...store.state,
      assets: [...store.state.assets, asset],
      dirty: true
    }
  }));
}

export interface FileImportResult {
  asset: ProjectAssetRef;
  extraParams?: Record<string, unknown>;
}

export async function importFileForActorParam(
  kernel: AppKernel,
  args: {
    projectPath: string;
    sourcePath: string;
    definition: FileParameterDefinition;
  }
): Promise<FileImportResult> {
  if (args.definition.import.mode === "transcode-hdri") {
    const asset = await importHdriToKtx2(kernel, {
      projectPath: args.projectPath,
      sourcePath: args.sourcePath,
      options: args.definition.import.options
    });
    return { asset };
  }

  // DAE import: capture textures and create materials
  if (args.definition.import.mode === "import-asset" && args.sourcePath.toLowerCase().endsWith(".dae")) {
    const result = await kernel.storage.importDae({
      projectPath: args.projectPath,
      sourcePath: args.sourcePath
    });

    // Add image assets to project state
    if (result.imageAssets.length > 0) {
      kernel.store.getState().actions.addAssets(result.imageAssets);
    }

    // Build actor-local material definitions (not added to the global library)
    const materialSlots: Record<string, string> = {};
    const localMaterials: Record<string, Material> = {};
    for (const def of result.materialDefs) {
      const mat: Material = {
        id: def.id,
        name: def.name,
        albedo: def.albedo,
        metalness: { mode: "scalar", value: def.metalness },
        roughness: { mode: "scalar", value: def.roughness },
        normalMap: def.normalMapAssetId ? { assetId: def.normalMapAssetId } : null,
        emissive: { mode: "color", color: def.emissive },
        emissiveIntensity: 0,
        opacity: 1,
        transparent: false,
        side: "front",
        wireframe: false
      };
      localMaterials[def.id] = mat;
      materialSlots[def.name] = def.id;
    }

    appendAsset(kernel, result.asset);
    kernel.projectService.queueAutosave();
    return { asset: result.asset, extraParams: { materialSlots, localMaterials } };
  }

  const asset = await kernel.storage.importAsset({
    projectPath: args.projectPath,
    sourcePath: args.sourcePath,
    kind: args.definition.import.kind
  });
  appendAsset(kernel, asset);
  kernel.projectService.queueAutosave();
  return { asset };
}

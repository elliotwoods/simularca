import type { AppKernel } from "@/app/kernel";
import type { FileParameterDefinition, Material } from "@/core/types";
import { importHdriToKtx2 } from "@/features/imports/hdriImport";
import type { SessionAssetRef } from "@/types/ipc";

function appendAsset(kernel: AppKernel, asset: SessionAssetRef): void {
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
  asset: SessionAssetRef;
  extraParams?: Record<string, unknown>;
}

export async function importFileForActorParam(
  kernel: AppKernel,
  args: {
    sessionName: string;
    sourcePath: string;
    definition: FileParameterDefinition;
  }
): Promise<FileImportResult> {
  if (args.definition.import.mode === "transcode-hdri") {
    const asset = await importHdriToKtx2(kernel, {
      sessionName: args.sessionName,
      sourcePath: args.sourcePath,
      options: args.definition.import.options
    });
    return { asset };
  }

  // DAE import: capture textures and create materials
  if (args.definition.import.mode === "import-asset" && args.sourcePath.toLowerCase().endsWith(".dae")) {
    const result = await kernel.storage.importDae({
      sessionName: args.sessionName,
      sourcePath: args.sourcePath
    });

    // Add image assets to session state
    if (result.imageAssets.length > 0) {
      kernel.store.getState().actions.addAssets(result.imageAssets);
    }

    // Create Material entities from DAE definitions
    const materialSlots: Record<string, string> = {};
    for (const def of result.materialDefs) {
      const matDef: Omit<Material, "id"> = {
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
      // Use the pre-computed ID from the main process
      kernel.store.setState((store) => ({
        ...store,
        state: {
          ...store.state,
          materials: {
            ...store.state.materials,
            [def.id]: { id: def.id, ...matDef }
          },
          dirty: true
        }
      }));
      materialSlots[def.name] = def.id;
    }

    appendAsset(kernel, result.asset);
    kernel.sessionService.queueAutosave();
    return { asset: result.asset, extraParams: { materialSlots } };
  }

  const asset =
    args.definition.import.kind === "gaussian-splat"
      ? await kernel.storage.importGaussianSplat({
          sessionName: args.sessionName,
          sourcePath: args.sourcePath
        })
      : await kernel.storage.importAsset({
          sessionName: args.sessionName,
          sourcePath: args.sourcePath,
          kind: args.definition.import.kind
        });
  appendAsset(kernel, asset);
  kernel.sessionService.queueAutosave();
  return { asset };
}

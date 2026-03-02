import type { AppKernel } from "@/app/kernel";
import { createActorFromDescriptor } from "@/features/actors/actorCatalog";

export interface SplatImportRequest {
  sessionName: string;
  sourcePath: string;
}

export async function importGaussianSplat(kernel: AppKernel, request: SplatImportRequest): Promise<string> {
  const asset = await kernel.storage.importAsset({
    sessionName: request.sessionName,
    sourcePath: request.sourcePath,
    kind: "gaussian-splat"
  });

  const actorId = createActorFromDescriptor(kernel, "actor.gaussianSplat");
  if (!actorId) {
    throw new Error("Missing actor descriptor: actor.gaussianSplat");
  }
  kernel.store.getState().actions.updateActorParams(actorId, {
    assetId: asset.id,
    scaleFactor: 1,
    opacity: 1,
    pointSize: 0.02
  });
  kernel.store.setState((store) => ({
    ...store,
    state: {
      ...store.state,
      assets: [...store.state.assets, asset]
    }
  }));
  kernel.sessionService.queueAutosave();
  return actorId;
}


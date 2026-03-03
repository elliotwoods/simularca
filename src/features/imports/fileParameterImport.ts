import type { AppKernel } from "@/app/kernel";
import type { FileParameterDefinition } from "@/core/types";
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

export async function importFileForActorParam(
  kernel: AppKernel,
  args: {
    sessionName: string;
    sourcePath: string;
    definition: FileParameterDefinition;
  }
): Promise<SessionAssetRef> {
  if (args.definition.import.mode === "transcode-hdri") {
    return importHdriToKtx2(kernel, {
      sessionName: args.sessionName,
      sourcePath: args.sourcePath,
      options: args.definition.import.options
    });
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
  return asset;
}

import type { AppKernel } from "@/app/kernel";
import type { SessionAssetRef } from "@/types/ipc";

export interface HdriImportRequest {
  sessionName: string;
  sourcePath: string;
  options?: {
    uastc?: boolean;
    zstdLevel?: number;
    generateMipmaps?: boolean;
  };
}

export async function importHdriToKtx2(kernel: AppKernel, request: HdriImportRequest): Promise<SessionAssetRef> {
  const asset = await kernel.storage.transcodeHdriToKtx2({
    sessionName: request.sessionName,
    sourcePath: request.sourcePath,
    options: request.options
  });
  kernel.store.setState((store) => ({
    ...store,
    state: {
      ...store.state,
      assets: [...store.state.assets, asset],
      dirty: true
    }
  }));
  kernel.sessionService.queueAutosave();
  return asset;
}


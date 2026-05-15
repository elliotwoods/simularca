import type { AppKernel } from "@/app/kernel";
import type { ProjectAssetRef } from "@/types/ipc";

export interface HdriImportRequest {
  projectPath: string;
  sourcePath: string;
  options?: {
    uastc?: boolean;
    zstdLevel?: number;
    generateMipmaps?: boolean;
  };
}

export async function importHdriToKtx2(kernel: AppKernel, request: HdriImportRequest): Promise<ProjectAssetRef> {
  const asset = await kernel.storage.transcodeHdriToKtx2({
    projectPath: request.projectPath,
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
  kernel.projectService.queueAutosave();
  return asset;
}

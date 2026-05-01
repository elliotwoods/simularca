import type { ElectronApi, RendererDebugBridge } from "./ipc";
import type { BuildInfo } from "../app/buildVersion";

declare global {
  interface Window {
    electronAPI?: ElectronApi;
    __SIMULARCA_DEBUG__?: RendererDebugBridge;
  }

  const __SIMULARCA_BUILD_INFO__: BuildInfo;
}

export {};


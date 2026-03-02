import { createAppStore } from "@/core/store/appStore";
import { SessionService } from "@/core/session/sessionService";
import { createStorageAdapter } from "@/features/storage";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import { HotReloadManager } from "@/core/hotReload/hotReloadManager";
import { createPluginApi } from "@/features/plugins/pluginApi";
import { SimulationClock } from "@/core/simulation/clock";

export interface AppKernel {
  store: ReturnType<typeof createAppStore>;
  storage: ReturnType<typeof createStorageAdapter>;
  sessionService: SessionService;
  descriptorRegistry: DescriptorRegistry;
  hotReloadManager: HotReloadManager;
  pluginApi: ReturnType<typeof createPluginApi>;
  clock: SimulationClock;
}

function createKernelInternal(): AppKernel {
  const storage = createStorageAdapter();
  const store = createAppStore(storage.mode);
  const descriptorRegistry = new DescriptorRegistry();
  const hotReloadManager = new HotReloadManager(descriptorRegistry, store);
  const pluginApi = createPluginApi(descriptorRegistry);
  const sessionService = new SessionService(storage, store);
  const clock = new SimulationClock(1 / 60);

  return {
    store,
    storage,
    sessionService,
    descriptorRegistry,
    hotReloadManager,
    pluginApi,
    clock
  };
}

const HMR_KEY = "simularca-kernel";

export function getKernel(): AppKernel {
  const hot = import.meta.hot;
  if (hot?.data[HMR_KEY]) {
    return hot.data[HMR_KEY] as AppKernel;
  }
  const kernel = createKernelInternal();
  if (hot) {
    hot.dispose((data) => {
      data[HMR_KEY] = kernel;
    });
  }
  return kernel;
}

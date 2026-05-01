import { createAppStore } from "@/core/store/appStore";
import { ProjectService } from "@/core/project/projectService";
import { createStorageAdapter } from "@/features/storage";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import { HotReloadManager } from "@/core/hotReload/hotReloadManager";
import { createPluginApi } from "@/features/plugins/pluginApi";
import { SimulationClock } from "@/core/simulation/clock";
import { ActorProfilingService } from "@/render/profiling";

export interface AppKernel {
  store: ReturnType<typeof createAppStore>;
  storage: ReturnType<typeof createStorageAdapter>;
  projectService: ProjectService;
  descriptorRegistry: DescriptorRegistry;
  hotReloadManager: HotReloadManager;
  pluginApi: ReturnType<typeof createPluginApi>;
  clock: SimulationClock;
  profiler: ActorProfilingService;
}

function migrateLegacyStorageKeys(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  const renames: ReadonlyArray<readonly [string, string]> = [
    ["rehearse-engine:flex-layout:v1", "simularca:flex-layout:v1"],
    ["rehearse-engine:roto-control:serial-port-override", "simularca:roto-control:serial-port-override"],
    ["rehearse-engine:roto-control:daw-emulation", "simularca:roto-control:daw-emulation"]
  ];
  for (const [oldKey, newKey] of renames) {
    if (localStorage.getItem(newKey) !== null) {
      continue;
    }
    const value = localStorage.getItem(oldKey);
    if (value === null) {
      continue;
    }
    localStorage.setItem(newKey, value);
    localStorage.removeItem(oldKey);
  }
}

function createKernelInternal(): AppKernel {
  migrateLegacyStorageKeys();
  const storage = createStorageAdapter();
  const store = createAppStore(storage.mode);
  const descriptorRegistry = new DescriptorRegistry();
  const hotReloadManager = new HotReloadManager(descriptorRegistry, store);
  const pluginApi = createPluginApi(descriptorRegistry, hotReloadManager);
  const projectService = new ProjectService(storage, store);
  const clock = new SimulationClock(1 / 60);
  const profiler = new ActorProfilingService();

  return {
    store,
    storage,
    projectService,
    descriptorRegistry,
    hotReloadManager,
    pluginApi,
    clock,
    profiler
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

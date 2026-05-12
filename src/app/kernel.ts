import { createAppStore } from "@/core/store/appStore";
import { ProjectService } from "@/core/project/projectService";
import { attachProjectionCacheStorage } from "@/features/curves/projectionCache";
import { createStorageAdapter } from "@/features/storage";
import type { WebStorageAdapterOptions } from "@/features/storage/webStorageAdapter";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import { HotReloadManager } from "@/core/hotReload/hotReloadManager";
import { createPluginApi } from "@/features/plugins/pluginApi";
import { SimulationClock } from "@/core/simulation/clock";
import { ActorProfilingService } from "@/render/profiling";
import type { PublishConfig } from "@/features/publish/publishConfigSchema";

export interface AppKernel {
  store: ReturnType<typeof createAppStore>;
  storage: ReturnType<typeof createStorageAdapter>;
  projectService: ProjectService;
  descriptorRegistry: DescriptorRegistry;
  hotReloadManager: HotReloadManager;
  pluginApi: ReturnType<typeof createPluginApi>;
  clock: SimulationClock;
  profiler: ActorProfilingService;
  /**
   * Non-null only in the published-snapshot viewer build. Drives panel
   * visibility and interaction gating in the read-only UI. Optional so
   * test fixtures that hand-construct kernel-shaped objects don't need to
   * supply it.
   */
  viewerConfig?: PublishConfig | null;
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

interface KernelBuildArgs {
  webStorageOptions?: WebStorageAdapterOptions;
  viewerConfig?: PublishConfig | null;
  attachProjectionCache: boolean;
}

function buildKernel(args: KernelBuildArgs): AppKernel {
  migrateLegacyStorageKeys();
  const storage = createStorageAdapter(args.webStorageOptions);
  const store = createAppStore(storage.mode);
  const descriptorRegistry = new DescriptorRegistry();
  const hotReloadManager = new HotReloadManager(descriptorRegistry, store);
  const pluginApi = createPluginApi(descriptorRegistry, hotReloadManager);
  const projectService = new ProjectService(storage, store);
  if (args.attachProjectionCache) {
    attachProjectionCacheStorage(storage, () => store.getState().state.activeProject?.path ?? null);
  }
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
    profiler,
    viewerConfig: args.viewerConfig ?? null
  };
}

function createKernelInternal(): AppKernel {
  return buildKernel({ attachProjectionCache: true });
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

export interface CreateViewerKernelArgs {
  webStorageOptions: WebStorageAdapterOptions;
  viewerConfig: PublishConfig;
}

/**
 * Builds a kernel for the published-snapshot viewer entry.
 *
 * Differences from the editor kernel:
 *  - Storage is forced to the web adapter, configured with the publish
 *    manifest and the bucket base URL.
 *  - The projection cache (write side) is skipped — there's no filesystem.
 *  - `viewerConfig` is non-null so UI gates can hide panels per the
 *    publisher's choices.
 *  - Asserts the identity-bridging invariant up-front (see
 *    `WebStorageAdapter`'s inline contract): the projectUuid must equal what
 *    `activeProject.path` will be set to.
 */
export function createViewerKernel(args: CreateViewerKernelArgs): AppKernel {
  const { manifest } = args.webStorageOptions;
  if (!manifest.project.uuid) {
    throw new Error("Viewer kernel: manifest.project.uuid is required.");
  }
  const kernel = buildKernel({
    webStorageOptions: args.webStorageOptions,
    viewerConfig: args.viewerConfig,
    attachProjectionCache: false
  });
  // Propagate the publisher's permission flags into the store so the
  // store-level `mutationAllowed` gate can read them when actions fire.
  kernel.store.setState((state) => ({
    ...state,
    state: {
      ...state.state,
      viewerPermissions: { ...args.viewerConfig.permissions }
    }
  }));
  return kernel;
}

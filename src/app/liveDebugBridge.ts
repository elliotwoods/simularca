import type { AppKernel } from "@/app/kernel";
import { BUILD_INFO } from "@/app/buildInfo";
import { executeConsoleSource, executeDebugSource, type ConsoleExecutionResult } from "@/core/console/runtime";
import type { RendererDebugBridge, RendererDebugSessionInfo } from "@/types/ipc";

function buildSessionInfo(kernel: AppKernel): RendererDebugSessionInfo {
  const state = kernel.store.getState().state;
  return {
    ready: true,
    buildKind: BUILD_INFO.buildKind,
    activeProjectName: state.activeProject?.name ?? "",
    activeSnapshotName: state.activeSnapshotName,
    mode: state.mode,
    selection: state.selection.map((entry) => ({ kind: entry.kind, id: entry.id })),
    actorCount: Object.keys(state.actors).length,
    componentCount: Object.keys(state.components).length,
    statusMessage: state.statusMessage
  };
}

export function createRendererDebugBridge(kernel: AppKernel): RendererDebugBridge {
  return {
    async executeConsole(source: string): Promise<ConsoleExecutionResult> {
      return await executeConsoleSource(kernel, source);
    },
    async executeEval(source: string): Promise<ConsoleExecutionResult> {
      return await executeDebugSource(kernel, source, {
        extraScope: {
          kernel,
          store: kernel.store,
          projectService: kernel.projectService,
          descriptorRegistry: kernel.descriptorRegistry,
          hotReloadManager: kernel.hotReloadManager,
          pluginApi: kernel.pluginApi,
          clock: kernel.clock,
          document: window.document,
          globalWindow: window,
          buildInfo: BUILD_INFO
        }
      });
    },
    sessionInfo(): RendererDebugSessionInfo {
      return buildSessionInfo(kernel);
    }
  };
}

export function installRendererDebugBridge(kernel: AppKernel): () => void {
  const bridge = createRendererDebugBridge(kernel);
  window.__SIMULARCA_DEBUG__ = bridge;
  return () => {
    if (window.__SIMULARCA_DEBUG__ === bridge) {
      delete window.__SIMULARCA_DEBUG__;
    }
  };
}

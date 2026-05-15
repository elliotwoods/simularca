import { describe, expect, it, vi } from "vitest";
import { createAppStore } from "@/core/store/appStore";
import { executeConsoleSource, executeDebugSource } from "@/core/console/runtime";
import type { AppKernel } from "@/app/kernel";
import { ActorProfilingService } from "@/render/profiling";

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {
      listProjects: vi.fn(async () => ["demo"])
    } as unknown as AppKernel["projectService"],
    descriptorRegistry: {} as AppKernel["descriptorRegistry"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: {
      listPlugins: vi.fn(() => [])
    } as unknown as AppKernel["pluginApi"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("console runtime", () => {
  it("executes standard console commands", async () => {
    const kernel = createKernelStub();

    const result = await executeConsoleSource(kernel, "scene.stats()");

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Command executed.");
  });

  it("executes debug eval with extra scope bindings", async () => {
    const kernel = createKernelStub();

    const result = await executeDebugSource(kernel, "({ mode: store.getState().state.mode, projectName: buildInfo.projectName })", {
      extraScope: {
        store: kernel.store,
        buildInfo: {
          projectName: "debug-project"
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.result).toEqual({
      mode: "electron-rw",
      projectName: "debug-project"
    });
  });

  it("returns camera debug info without a mounted viewport", async () => {
    const kernel = createKernelStub();

    const result = await executeConsoleSource(kernel, "camera.debug()");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.result).toEqual({
      available: false,
      backend: kernel.store.getState().state.scene.renderEngine,
      storeCamera: kernel.store.getState().state.camera
    });
  });

  it("exposes profiler state and summaries through scene.profile", async () => {
    const kernel = createKernelStub();
    kernel.profiler.startCapture({
      frameCount: 1,
      includeUpdateTimings: true,
      includeDrawTimings: false,
      includeGpuTimings: false,
      detailPreset: "minimal"
    });
    kernel.profiler.beginFrame();
    kernel.profiler.finishFrame({ cpuTotalDurationMs: 12.5 });

    const stateResult = await executeConsoleSource(kernel, "scene.profile.state()");
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) {
      throw new Error(stateResult.error);
    }
    expect((stateResult.result as { phase?: string }).phase).toBe("completed");

    const summaryResult = await executeConsoleSource(kernel, "scene.profile.latestSummary()");
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) {
      throw new Error(summaryResult.error);
    }
    expect((summaryResult.result as { summary?: { cpu?: { averageFrameMs?: number | null } } }).summary?.cpu?.averageFrameMs).toBe(12.5);
    expect((summaryResult.result as { survey?: { cpu?: { worstFrame?: { frameIndex?: number } } } }).survey?.cpu?.worstFrame?.frameIndex).toBe(0);
  });
});

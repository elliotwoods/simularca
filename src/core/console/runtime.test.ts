import { describe, expect, it, vi } from "vitest";
import { createAppStore } from "@/core/store/appStore";
import { executeConsoleSource, executeDebugSource } from "@/core/console/runtime";
import type { AppKernel } from "@/app/kernel";

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
    clock: {} as AppKernel["clock"]
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
      backend: "webgl2",
      storeCamera: kernel.store.getState().state.camera
    });
  });
});

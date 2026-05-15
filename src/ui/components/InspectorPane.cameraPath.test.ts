import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { KernelProvider } from "@/app/KernelContext";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import { cameraPathActorDescriptor } from "@/features/actors/descriptors/cameraPathActor";
import { curveActorDescriptor } from "@/features/actors/descriptors/curveActor";
import { ActorProfilingService } from "@/render/profiling";
import { InspectorPane } from "@/ui/components/InspectorPane";

class ResizeObserverMock {
  public observe(): void {}
  public disconnect(): void {}
  public unobserve(): void {}
}

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: { queueAutosave() {} } as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: {
      listPlugins: () => [],
      subscribe: () => () => {},
      getRevision: () => 0
    } as unknown as AppKernel["pluginApi"],
    descriptorRegistry: {
      listByKind: () => [cameraPathActorDescriptor, curveActorDescriptor]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("InspectorPane camera path", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      font: "",
      measureText: () => ({ width: 8 })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    if (originalResizeObserver) {
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    document.body.innerHTML = "";
  });

  it("mounts for a selected new camera path", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const parentId = actions.createActor({ actorType: "camera-path", name: "Camera Path" });
    const positionId = actions.createActor({ actorType: "curve", name: "camera position", parentActorId: parentId });
    const targetId = actions.createActor({ actorType: "curve", name: "camera target", parentActorId: parentId });
    actions.updateActorParams(parentId, {
      positionCurveActorId: positionId,
      targetCurveActorId: targetId,
      targetMode: "curve",
      targetActorId: "",
      keyframes: [{ id: "kf0", timeSeconds: 0 }]
    });
    actions.updateActorParams(positionId, {
      curveData: {
        closed: false,
        points: [{ position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }]
      }
    });
    actions.updateActorParams(targetId, {
      curveData: {
        closed: false,
        points: [{ position: [0, 0, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }]
      }
    });
    actions.select([{ kind: "actor", id: parentId }]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(InspectorPane)
        )
      );
    });

    expect(container.textContent).toContain("Camera Path");
    expect(container.textContent).toContain("Keyframes");

    await act(async () => {
      root.unmount();
    });
  });

  it("survives selection transitions between scene and camera path", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const parentId = actions.createActor({ actorType: "camera-path", name: "Camera Path" });
    const positionId = actions.createActor({ actorType: "curve", name: "camera position", parentActorId: parentId });
    const targetId = actions.createActor({ actorType: "curve", name: "camera target", parentActorId: parentId });
    actions.updateActorParams(parentId, {
      positionCurveActorId: positionId,
      targetCurveActorId: targetId,
      targetMode: "curve",
      targetActorId: "",
      keyframes: [{ id: "kf0", timeSeconds: 0 }]
    });
    actions.updateActorParams(positionId, {
      curveData: {
        closed: false,
        points: [{ position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }]
      }
    });
    actions.updateActorParams(targetId, {
      curveData: {
        closed: false,
        points: [{ position: [0, 0, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }]
      }
    });
    actions.select([]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(InspectorPane)
        )
      );
    });

    expect(container.textContent).toContain("Scene");

    await act(async () => {
      actions.select([{ kind: "actor", id: parentId }]);
    });

    expect(container.textContent).toContain("Camera Path");
    expect(container.textContent).toContain("Keyframes");

    await act(async () => {
      actions.select([]);
    });

    expect(container.textContent).toContain("Scene");

    await act(async () => {
      root.unmount();
    });
  });
});

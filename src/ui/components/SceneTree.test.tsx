import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import type { AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { createAppStore } from "@/core/store/appStore";
import { ActorProfilingService } from "@/render/profiling";
import { SceneTree } from "@/ui/components/SceneTree";

class DataTransferStub {
  private readonly values = new Map<string, string>();
  private forceEmptyReads = false;
  effectAllowed = "";

  setData(type: string, value: string) {
    this.values.set(type, value);
  }

  getData(type: string) {
    if (this.forceEmptyReads) {
      return "";
    }
    return this.values.get(type) ?? "";
  }

  setForceEmptyReads(next: boolean) {
    this.forceEmptyReads = next;
  }
}

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    descriptorRegistry: {} as AppKernel["descriptorRegistry"],
    pluginApi: {
      listPlugins: () => []
    } as unknown as AppKernel["pluginApi"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

function dispatchDragEvent(
  element: Element,
  type: string,
  dataTransfer: DataTransferStub,
  coords?: { clientY?: number; clientX?: number }
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer
  });
  // jsdom getBoundingClientRect is all zeros, so the row's drop zones collapse onto y=0:
  // clientY < 0 -> before, clientY > 0 -> after, clientY == 0 -> into.
  if (coords?.clientY !== undefined) {
    Object.defineProperty(event, "clientY", { value: coords.clientY });
  }
  if (coords?.clientX !== undefined) {
    Object.defineProperty(event, "clientX", { value: coords.clientX });
  }
  element.dispatchEvent(event);
}

describe("SceneTree", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show a drop preview on dragstart alone, then previews a before-row line on dragover even when hover reads are empty", async () => {
    const kernel = createKernelStub();
    const alphaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Alpha" });
    const groupId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Group" });
    const betaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Beta" });
    expect(kernel.store.getState().state.scene.actorIds).toEqual([alphaId, groupId, betaId]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(SceneTree)
        )
      );
    });

    const betaRow = container.querySelector(`[data-actor-row-id="${betaId}"]`) as HTMLDivElement | null;
    const groupRow = container.querySelector(`[data-actor-row-id="${groupId}"]`) as HTMLDivElement | null;
    expect(betaRow).not.toBeNull();
    expect(groupRow).not.toBeNull();

    const dataTransfer = new DataTransferStub();

    await act(async () => {
      dispatchDragEvent(betaRow!, "dragstart", dataTransfer);
    });

    expect(container.querySelector("[data-scene-tree-drop-preview='true']")).toBeNull();

    dataTransfer.setForceEmptyReads(true);

    // Hover the top band of the Group row -> insert before Group (depth 1 -> left 20px).
    await act(async () => {
      dispatchDragEvent(groupRow!, "dragover", dataTransfer, { clientY: -1 });
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("20px");

    dataTransfer.setForceEmptyReads(false);

    await act(async () => {
      dispatchDragEvent(groupRow!, "drop", dataTransfer, { clientY: -1 });
    });

    expect(kernel.store.getState().state.scene.actorIds).toEqual([alphaId, betaId, groupId]);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses row hover to preview the final child-append line for expanded groups", async () => {
    const kernel = createKernelStub();
    const alphaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Alpha" });
    const groupId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Group" });
    const childId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "empty",
      name: "Child",
      parentActorId: groupId
    });
    expect(kernel.store.getState().state.actors[childId]?.parentActorId).toBe(groupId);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(SceneTree)
        )
      );
    });

    const alphaRow = container.querySelector(`[data-actor-row-id="${alphaId}"]`) as HTMLDivElement | null;
    const groupRow = container.querySelector(`[data-actor-row-id="${groupId}"]`) as HTMLDivElement | null;
    expect(alphaRow).not.toBeNull();
    expect(groupRow).not.toBeNull();

    const dataTransfer = new DataTransferStub();

    // Hover the middle band of the expanded Group row -> drop inside as a child. The line is
    // drawn just under the header (depth 2 -> left 32px), so the item lands as the first child.
    await act(async () => {
      dispatchDragEvent(alphaRow!, "dragstart", dataTransfer);
      dispatchDragEvent(groupRow!, "dragover", dataTransfer, { clientY: 0 });
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("32px");

    await act(async () => {
      dispatchDragEvent(groupRow!, "drop", dataTransfer, { clientY: 0 });
    });

    const state = kernel.store.getState().state;
    expect(state.actors[alphaId]?.parentActorId).toBe(groupId);
    expect(state.actors[groupId]?.childActorIds).toEqual([alphaId, childId]);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an inline insertion line on empty group rows", async () => {
    const kernel = createKernelStub();
    const alphaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Alpha" });
    const groupId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Group" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(SceneTree)
        )
      );
    });

    const alphaRow = container.querySelector(`[data-actor-row-id="${alphaId}"]`) as HTMLDivElement | null;
    const groupRow = container.querySelector(`[data-actor-row-id="${groupId}"]`) as HTMLDivElement | null;
    expect(alphaRow).not.toBeNull();
    expect(groupRow).not.toBeNull();

    const dataTransfer = new DataTransferStub();

    // Empty group: the middle band drops inside as the first/only child (depth 2 -> left 32px).
    await act(async () => {
      dispatchDragEvent(alphaRow!, "dragstart", dataTransfer);
      dispatchDragEvent(groupRow!, "dragover", dataTransfer, { clientY: 0 });
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("32px");

    await act(async () => {
      root.unmount();
    });
  });

  it("reorders root siblings when dropping on the after-band of a row", async () => {
    const kernel = createKernelStub();
    const alphaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Alpha" });
    const betaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Beta" });
    const gammaId = kernel.store.getState().actions.createActorNoHistory({ actorType: "empty", name: "Gamma" });
    expect(kernel.store.getState().state.scene.actorIds).toEqual([alphaId, betaId, gammaId]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(SceneTree)
        )
      );
    });

    const alphaRow = container.querySelector(`[data-actor-row-id="${alphaId}"]`) as HTMLDivElement | null;
    const gammaRow = container.querySelector(`[data-actor-row-id="${gammaId}"]`) as HTMLDivElement | null;
    expect(alphaRow).not.toBeNull();
    expect(gammaRow).not.toBeNull();

    const dataTransfer = new DataTransferStub();

    // Drag Gamma onto Alpha's bottom band (clientY > 0) -> insert after Alpha (depth 1 -> 20px).
    await act(async () => {
      dispatchDragEvent(gammaRow!, "dragstart", dataTransfer);
      dispatchDragEvent(alphaRow!, "dragover", dataTransfer, { clientY: 1 });
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("20px");

    await act(async () => {
      dispatchDragEvent(alphaRow!, "drop", dataTransfer, { clientY: 1 });
    });

    expect(kernel.store.getState().state.scene.actorIds).toEqual([alphaId, gammaId, betaId]);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a warning indicator for plugin actors whose plugin type is unavailable", async () => {
    const kernel = createKernelStub();
    const pluginActorId = kernel.store.getState().actions.createActorNoHistory({
      actorType: "plugin",
      pluginType: "plugin.missing.actor",
      name: "Missing Plugin Actor"
    });
    kernel.store.getState().actions.setActorStatus(pluginActorId, {
      values: {
        pluginMissing: true,
        pluginMissingReason: "Plugin actor type is unavailable: plugin.missing.actor"
      },
      updatedAtIso: new Date().toISOString()
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(SceneTree)
        )
      );
    });

    const warning = container.querySelector(
      `[data-actor-row-id="${pluginActorId}"] .scene-tree-load-state.conflict`
    ) as HTMLSpanElement | null;
    expect(warning).not.toBeNull();
    expect(warning?.getAttribute("title")).toBe("Plugin actor type is unavailable: plugin.missing.actor");

    await act(async () => {
      root.unmount();
    });
  });
});

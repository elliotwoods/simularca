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

function dispatchDragEvent(element: Element, type: string, dataTransfer: DataTransferStub) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer
  });
  element.dispatchEvent(event);
}

describe("SceneTree", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show a drop preview on dragstart alone, then previews a before-row gap on dragover even when hover reads are empty", async () => {
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
    const groupBeforeGap = container.querySelector(
      `[data-drop-kind="before-row"][data-drop-target-id="${groupId}"]`
    ) as HTMLDivElement | null;
    expect(betaRow).not.toBeNull();
    expect(groupBeforeGap).not.toBeNull();

    const dataTransfer = new DataTransferStub();

    await act(async () => {
      dispatchDragEvent(betaRow!, "dragstart", dataTransfer);
    });

    expect(container.querySelector(".scene-tree-drop-gap.is-active")).toBeNull();

    dataTransfer.setForceEmptyReads(true);

    await act(async () => {
      dispatchDragEvent(groupBeforeGap!, "dragover", dataTransfer);
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("20px");

    dataTransfer.setForceEmptyReads(false);

    await act(async () => {
      dispatchDragEvent(groupBeforeGap!, "drop", dataTransfer);
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

    await act(async () => {
      dispatchDragEvent(alphaRow!, "dragstart", dataTransfer);
      dispatchDragEvent(groupRow!, "dragover", dataTransfer);
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("32px");

    await act(async () => {
      dispatchDragEvent(groupRow!, "drop", dataTransfer);
    });

    const state = kernel.store.getState().state;
    expect(state.actors[alphaId]?.parentActorId).toBe(groupId);
    expect(state.actors[groupId]?.childActorIds).toEqual([childId, alphaId]);

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

    await act(async () => {
      dispatchDragEvent(alphaRow!, "dragstart", dataTransfer);
      dispatchDragEvent(groupRow!, "dragover", dataTransfer);
    });

    const preview = container.querySelector("[data-scene-tree-drop-preview='true']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe("32px");

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

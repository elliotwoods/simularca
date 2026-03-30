import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { KernelProvider } from "@/app/KernelContext";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import { beamEmitterArrayDescriptor, beamEmitterDescriptor } from "../../../plugins/beam-crossover-plugin/src/beamPlugin";
import { mistVolumeActorDescriptor } from "@/features/actors/descriptors/mistVolumeActor";
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
      listByKind: () => [beamEmitterDescriptor, beamEmitterArrayDescriptor, mistVolumeActorDescriptor]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"]
  };
}

describe("InspectorPane beam emitter", () => {
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

  it("shows shader properties drill-in and resolves scattering-shell defaults on first open", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const actorId = actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.beamCrossover.emitter",
      name: "Beam Emitter"
    });
    actions.select([{ kind: "actor", id: actorId }]);

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

    expect(container.querySelectorAll(".reference-picker-trigger")).toHaveLength(2);
    const shaderButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Shader Properties"));
    expect(shaderButton).toBeTruthy();

    await act(async () => {
      shaderButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Beam Type");
    expect(container.textContent).toContain("Haze Intensity");
    expect(container.textContent).toContain("Scattering Coefficient");
    expect(container.querySelectorAll(".reference-picker-trigger")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows mist volume ref at the root for beam emitter array", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const actorId = actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.beamCrossover.emitterArray",
      name: "Beam Emitter Array"
    });
    actions.select([{ kind: "actor", id: actorId }]);

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

    expect(container.querySelectorAll(".reference-picker-trigger")).toHaveLength(3);
    expect(container.textContent).toContain("Shader Properties");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows xyz scale controls and resets scale to one", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const actorId = actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.beamCrossover.emitter",
      name: "Beam Emitter"
    });
    actions.setActorTransform(actorId, "scale", [2, 3, 4]);
    actions.select([{ kind: "actor", id: actorId }]);

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

    expect(container.textContent).toContain("Scale");
    expect(container.textContent).toContain("X");
    expect(container.textContent).toContain("Y");
    expect(container.textContent).toContain("Z");

    const resetScaleButton = Array.from(container.querySelectorAll("button")).find((button) => button.title === "Reset Scale");
    expect(resetScaleButton).toBeTruthy();

    await act(async () => {
      resetScaleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(kernel.store.getState().state.actors[actorId]?.transform.scale).toEqual([1, 1, 1]);

    await act(async () => {
      root.unmount();
    });
  });

  it("groups mist parameters into drill-in sections", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const actorId = actions.createActor({
      actorType: "mist-volume",
      name: "Mist Volume"
    });
    actions.updateActorParams(actorId, {
      volumeActorId: "",
      sourceActorIds: [],
      resolutionX: 32,
      resolutionY: 24,
      resolutionZ: 32,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      emissionDirection: [0, -1, 0],
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0.08,
      simulationSubsteps: 1,
      noiseSeed: 1,
      emissionNoiseStrength: 0,
      emissionNoiseScale: 1,
      emissionNoiseSpeed: 0.75,
      windVector: [0, 0, 0],
      windNoiseStrength: 0,
      windNoiseScale: 0.75,
      windNoiseSpeed: 0.25,
      wispiness: 0,
      edgeBreakup: 0,
      previewMode: "volume",
      previewTint: "#d9eef7",
      previewOpacity: 1.1,
      previewThreshold: 0.02,
      previewRaymarchSteps: 48,
      renderOverrideEnabled: false
    });
    actions.select([{ kind: "actor", id: actorId }]);

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

    expect(container.textContent).toContain("Volume");
    expect(container.textContent).toContain("Emission");
    expect(container.textContent).toContain("Physics");
    expect(container.textContent).toContain("Noise");
    expect(container.textContent).not.toContain("Buoyancy");

    const noiseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Noise"));
    expect(noiseButton).toBeTruthy();

    await act(async () => {
      noiseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Noise Seed");
    expect(container.textContent).toContain("Wind Vector");
    expect(container.textContent).toContain("Wispiness");
    expect(container.textContent).not.toContain("Resolution X");

    await act(async () => {
      root.unmount();
    });
  });
});

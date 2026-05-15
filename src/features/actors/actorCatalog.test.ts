import { describe, expect, it } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import { createActorFromDescriptor, listActorCreationOptions } from "@/features/actors/actorCatalog";
import { cameraPathActorDescriptor } from "@/features/actors/descriptors/cameraPathActor";
import { curveActorDescriptor } from "@/features/actors/descriptors/curveActor";
import { dxfReferenceActorDescriptor } from "@/features/actors/descriptors/dxfReferenceActor";
import { environmentProbeActorDescriptor } from "@/features/actors/descriptors/environmentProbeActor";
import { mistVolumeActorDescriptor } from "@/features/actors/descriptors/mistVolumeActor";
import { primitiveActorDescriptor } from "@/features/actors/descriptors/primitiveActor";
import { ActorProfilingService } from "@/render/profiling";

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: {
      listPlugins: () => []
    } as unknown as AppKernel["pluginApi"],
    descriptorRegistry: {
      listByKind: () => [
        cameraPathActorDescriptor,
        curveActorDescriptor,
        dxfReferenceActorDescriptor,
        environmentProbeActorDescriptor,
        mistVolumeActorDescriptor,
        primitiveActorDescriptor
      ]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("actorCatalog camera path creation", () => {
  it("creates a parent camera path with managed child curves in one undo step", () => {
    const kernel = createKernelStub();
    kernel.store.getState().actions.setCameraState({
      position: [10, 20, 30],
      target: [1, 2, 3]
    });

    const actorId = createActorFromDescriptor(kernel, "actor.cameraPath");
    expect(actorId).toBeTruthy();
    const state = kernel.store.getState().state;
    const actor = actorId ? state.actors[actorId] : null;
    expect(actor?.actorType).toBe("camera-path");
    expect(kernel.store.getState().historyPast).toHaveLength(1);

    const positionCurveActorId = typeof actor?.params.positionCurveActorId === "string" ? actor.params.positionCurveActorId : "";
    const targetCurveActorId = typeof actor?.params.targetCurveActorId === "string" ? actor.params.targetCurveActorId : "";
    const positionCurve = state.actors[positionCurveActorId];
    const targetCurve = state.actors[targetCurveActorId];

    expect(positionCurve?.parentActorId).toBe(actorId);
    expect(targetCurve?.parentActorId).toBe(actorId);
    expect(actor?.params.keyframes).toMatchObject([{ timeSeconds: 0 }]);
    expect(positionCurve?.params.curveData).toMatchObject({
      points: [{ position: [10, 20, 30], mode: "auto" }]
    });
    expect(targetCurve?.params.curveData).toMatchObject({
      points: [{ position: [1, 2, 3], mode: "auto" }]
    });

    kernel.store.getState().actions.undo();
    expect(kernel.store.getState().state.actors[actorId ?? ""]).toBeUndefined();
    expect(positionCurveActorId ? kernel.store.getState().state.actors[positionCurveActorId] : undefined).toBeUndefined();
    expect(targetCurveActorId ? kernel.store.getState().state.actors[targetCurveActorId] : undefined).toBeUndefined();
  });

  it("defaults new primitive actors to sphere", () => {
    const kernel = createKernelStub();

    const actorId = createActorFromDescriptor(kernel, "actor.primitive");
    expect(actorId).toBeTruthy();

    const state = kernel.store.getState().state;
    const actor = actorId ? state.actors[actorId] : null;
    expect(actor?.actorType).toBe("primitive");
    expect(actor?.params.shape).toBe("sphere");
    expect(actor?.params.sphereRadius).toBe(0.5);
  });

  it("offers and creates analytic circle curves as curve actors", () => {
    const kernel = createKernelStub();
    const options = listActorCreationOptions(kernel);
    expect(options.some((option) => option.descriptorId === "actor.curve.circle" && option.label === "Circle")).toBe(true);

    const actorId = createActorFromDescriptor(kernel, "actor.curve.circle");
    expect(actorId).toBeTruthy();

    const actor = actorId ? kernel.store.getState().state.actors[actorId] : null;
    expect(actor?.actorType).toBe("curve");
    expect(actor?.params.curveType).toBe("circle");
    expect(actor?.params.radius).toBe(1);
    expect(actor?.params.samplesPerSegment).toBe(64);
  });

  it("defaults new environment probes to sphere preview", () => {
    const kernel = createKernelStub();

    const actorId = createActorFromDescriptor(kernel, "actor.environmentProbe");
    expect(actorId).toBeTruthy();

    const actor = actorId ? kernel.store.getState().state.actors[actorId] : null;
    expect(actor?.actorType).toBe("environment-probe");
    expect(actor?.params.actorIds).toEqual([]);
    expect(actor?.params.resolution).toBe(256);
    expect(actor?.params.preview).toBe("sphere");
    expect(actor?.params.renderMode).toBe("on-change");
  });

  it("seeds new DXF actors with source-plane defaults", () => {
    const kernel = createKernelStub();

    const actorId = createActorFromDescriptor(kernel, "actor.dxfReference");
    expect(actorId).toBeTruthy();

    const actor = actorId ? kernel.store.getState().state.actors[actorId] : null;
    expect(actor?.actorType).toBe("dxf-reference");
    expect(actor?.params.inputUnits).toBe("millimeters");
    expect(actor?.params.sourcePlane).toBe("auto");
    expect(actor?.params.drawingPlane).toBe("plan-xz");
    expect(actor?.params.curveResolution).toBe(32);
  });

  it("seeds new mist volume actors with preview and render-quality defaults", () => {
    const kernel = createKernelStub();

    const actorId = createActorFromDescriptor(kernel, "actor.mistVolume");
    expect(actorId).toBeTruthy();

    const actor = actorId ? kernel.store.getState().state.actors[actorId] : null;
    expect(actor?.actorType).toBe("mist-volume");
    expect(actor?.params.volumeActorId).toBe("");
    expect(actor?.params.resolutionX).toBe(32);
    expect(actor?.params.emissionDirection).toEqual([0, -1, 0]);
    expect(actor?.params.noiseSeed).toBe(1);
    expect(actor?.params.emissionNoiseStrength).toBe(0);
    expect(actor?.params.windVector).toEqual([0, 0, 0]);
    expect(actor?.params.wispiness).toBe(0);
    expect(actor?.params.edgeBreakup).toBe(0);
    expect(actor?.params.lookupNoisePreset).toBe("cloudy");
    expect(actor?.params.lookupNoiseStrength).toBe(0.45);
    expect(actor?.params.lookupNoiseScale).toBe(1.6);
    expect(actor?.params.lookupNoiseSpeed).toBe(0.12);
    expect(actor?.params.lookupNoiseScroll).toEqual([0.03, 0.06, 0.02]);
    expect(actor?.params.lookupNoiseContrast).toBe(0.9);
    expect(actor?.params.lookupNoiseBias).toBe(0.08);
    expect(actor?.params.surfaceNegXMode).toBe("open");
    expect(actor?.params.surfacePosXMode).toBe("open");
    expect(actor?.params.surfaceNegYMode).toBe("open");
    expect(actor?.params.surfacePosYMode).toBe("open");
    expect(actor?.params.surfaceNegZMode).toBe("open");
    expect(actor?.params.surfacePosZMode).toBe("open");
    expect(actor?.params.previewMode).toBe("volume");
    expect(actor?.params.debugOverlayMode).toBe("off");
    expect(actor?.params.debugGridResolutionX).toBe(6);
    expect(actor?.params.debugGridResolutionY).toBe(5);
    expect(actor?.params.debugGridResolutionZ).toBe(6);
    expect(actor?.params.debugValueSize).toBe(0.08);
    expect(actor?.params.debugHideZeroNumbers).toBe(true);
    expect(actor?.params.debugDensityThreshold).toBe(0.02);
    expect(actor?.params.debugVectorScale).toBe(0.25);
    expect(actor?.params.debugSourceMarkers).toBe(false);
    expect(actor?.params.slicePosition).toBe(0.5);
    expect(actor?.params.previewRaymarchSteps).toBe(48);
    expect(actor?.params.renderOverrideEnabled).toBe(false);
    expect(actor?.params.renderResolutionX).toBe(64);
  });
});

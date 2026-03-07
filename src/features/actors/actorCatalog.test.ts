import { describe, expect, it } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import { createActorFromDescriptor } from "@/features/actors/actorCatalog";
import { cameraPathActorDescriptor } from "@/features/actors/descriptors/cameraPathActor";
import { curveActorDescriptor } from "@/features/actors/descriptors/curveActor";
import { primitiveActorDescriptor } from "@/features/actors/descriptors/primitiveActor";

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
      listByKind: () => [cameraPathActorDescriptor, curveActorDescriptor, primitiveActorDescriptor]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"]
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
});

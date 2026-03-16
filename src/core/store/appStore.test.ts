import { describe, expect, it } from "vitest";
import { createAppStore } from "@/core/store/appStore";

describe("appStore undo/redo", () => {
  it("undoes and redoes actor creation", () => {
    const store = createAppStore("web-ro");
    const initialCount = Object.keys(store.getState().state.actors).length;

    store.getState().actions.createActor({
      actorType: "empty",
      name: "Test Actor"
    });

    const countAfterCreate = Object.keys(store.getState().state.actors).length;
    expect(countAfterCreate).toBe(initialCount + 1);

    store.getState().actions.undo();
    const countAfterUndo = Object.keys(store.getState().state.actors).length;
    expect(countAfterUndo).toBe(initialCount);

    store.getState().actions.redo();
    const countAfterRedo = Object.keys(store.getState().state.actors).length;
    expect(countAfterRedo).toBe(initialCount + 1);
  });

  it("ensures actor names are unique on create and rename", () => {
    const store = createAppStore("electron-rw");
    const actions = store.getState().actions;

    const firstId = actions.createActor({
      actorType: "empty",
      name: "Tree"
    });
    const secondId = actions.createActor({
      actorType: "empty",
      name: "Tree"
    });

    expect(store.getState().state.actors[firstId]?.name).toBe("Tree");
    expect(store.getState().state.actors[secondId]?.name).toBe("Tree2");

    actions.renameNode({ kind: "actor", id: secondId }, "Tree");
    expect(store.getState().state.actors[secondId]?.name).toBe("Tree2");

    actions.renameNode({ kind: "actor", id: secondId }, "Tree2");
    expect(store.getState().state.actors[secondId]?.name).toBe("Tree2");
  });

  it("updates actor params without adding history entries when using no-history path", () => {
    const store = createAppStore("web-ro");
    const actorId = store.getState().actions.createActor({
      actorType: "empty",
      name: "Curve Carrier"
    });

    const historyAfterCreate = store.getState().historyPast.length;
    store.getState().actions.updateActorParamsNoHistory(actorId, {
      curveData: {
        closed: false,
        points: [
          {
            position: [0, 0, 0],
            handleIn: [-0.2, 0, 0],
            handleOut: [0.2, 0, 0],
            mode: "mirrored"
          },
          {
            position: [1, 0, 0],
            handleIn: [-0.2, 0, 0],
            handleOut: [0.2, 0, 0],
            mode: "mirrored"
          }
        ]
      }
    });

    expect(store.getState().historyPast.length).toBe(historyAfterCreate);
    const actor = store.getState().state.actors[actorId];
    expect(actor?.params.curveData).toBeTruthy();
  });

  it("updates actor transform without adding history entries when using no-history path", () => {
    const store = createAppStore("web-ro");
    const actorId = store.getState().actions.createActor({
      actorType: "empty",
      name: "Transform Target"
    });

    const historyAfterCreate = store.getState().historyPast.length;
    store.getState().actions.setActorTransformNoHistory(actorId, "position", [2, 3, 4]);

    expect(store.getState().historyPast.length).toBe(historyAfterCreate);
    expect(store.getState().state.actors[actorId]?.transform.position).toEqual([2, 3, 4]);
  });

  it("updates runtime debug settings without dirtying the project or adding history", () => {
    const store = createAppStore("web-ro");
    const historyBefore = store.getState().historyPast.length;
    const dirtyBefore = store.getState().state.dirty;

    store.getState().actions.setRuntimeDebugSettings({
      slowFrameDiagnosticsEnabled: true,
      slowFrameDiagnosticsThresholdMs: 160
    });

    expect(store.getState().historyPast.length).toBe(historyBefore);
    expect(store.getState().state.dirty).toBe(dirtyBefore);
    expect(store.getState().state.runtimeDebug).toEqual({
      slowFrameDiagnosticsEnabled: true,
      slowFrameDiagnosticsThresholdMs: 160
    });
  });

  it("updates scene tonemapping settings independently", () => {
    const store = createAppStore("electron-rw");

    store.getState().actions.setSceneRenderSettings({
      tonemapping: {
        dither: false
      }
    });

    expect(store.getState().state.scene.tonemapping).toEqual({
      mode: "aces",
      dither: false
    });

    store.getState().actions.setSceneRenderSettings({
      tonemapping: {
        mode: "off"
      }
    });

    expect(store.getState().state.scene.tonemapping).toEqual({
      mode: "off",
      dither: false
    });
  });

  it("updates scene frame pacing settings independently", () => {
    const store = createAppStore("electron-rw");

    store.getState().actions.setSceneRenderSettings({
      framePacing: {
        targetFps: 120
      }
    });

    expect(store.getState().state.scene.framePacing).toEqual({
      mode: "vsync",
      targetFps: 120
    });

    store.getState().actions.setSceneRenderSettings({
      framePacing: {
        mode: "fixed"
      }
    });

    expect(store.getState().state.scene.framePacing).toEqual({
      mode: "fixed",
      targetFps: 120
    });
  });

  it("falls back to immediate camera updates when no transition driver is registered", () => {
    const store = createAppStore("electron-rw");

    store.getState().actions.requestCameraState({
      mode: "perspective",
      position: [2, 3, 4],
      target: [0, 0, 0],
      fov: 50,
      zoom: 1,
      near: 0.01,
      far: 1000
    });

    expect(store.getState().state.camera.position).toEqual([2, 3, 4]);
    expect(store.getState().state.dirty).toBe(true);
  });
});


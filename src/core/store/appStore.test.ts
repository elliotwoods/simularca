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
});


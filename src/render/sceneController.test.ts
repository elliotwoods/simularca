import { describe, expect, test } from "vitest";
import { createInitialState } from "@/core/defaults";
import type { ActorNode, ActorRuntimeStatus } from "@/core/types";
import { buildEnvironmentProbeSelectedActorSignature } from "@/render/sceneController";

function createMeshActor(): ActorNode {
  return {
    id: "actor.mesh",
    name: "Mesh",
    kind: "actor",
    actorType: "mesh",
    enabled: true,
    visibilityMode: "visible",
    pluginType: undefined,
    parentActorId: null,
    childActorIds: [],
    componentIds: [],
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params: {
      assetId: "",
      materialId: "",
      materialSlots: {}
    }
  };
}

describe("buildEnvironmentProbeSelectedActorSignature", () => {
  test("ignores volatile runtime status timestamps", () => {
    const state = createInitialState("electron-rw", "test", "main");
    const actor = createMeshActor();
    state.actors[actor.id] = actor;

    const loadingStatus: ActorRuntimeStatus = {
      values: { loadState: "loaded", visibleChunks: 12 },
      updatedAtIso: "2026-04-01T00:00:00.000Z"
    };
    const laterLoadingStatus: ActorRuntimeStatus = {
      values: { loadState: "loaded", visibleChunks: 99 },
      updatedAtIso: "2026-04-01T00:00:10.000Z"
    };

    state.actorStatusByActorId[actor.id] = loadingStatus;
    const first = buildEnvironmentProbeSelectedActorSignature(actor.id, state);

    state.actorStatusByActorId[actor.id] = laterLoadingStatus;
    const second = buildEnvironmentProbeSelectedActorSignature(actor.id, state);

    expect(first).toBe(second);
  });

  test("changes when stable actor inputs change", () => {
    const state = createInitialState("electron-rw", "test", "main");
    const actor = createMeshActor();
    state.actors[actor.id] = actor;

    const before = buildEnvironmentProbeSelectedActorSignature(actor.id, state);
    state.actors[actor.id] = {
      ...actor,
      transform: {
        ...actor.transform,
        position: [1, 2, 3]
      }
    };
    const after = buildEnvironmentProbeSelectedActorSignature(actor.id, state);

    expect(before).not.toBe(after);
  });
});

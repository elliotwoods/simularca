import { describe, expect, test } from "vitest";
import { createInitialState } from "@/core/defaults";
import type { ActorNode, ActorRuntimeStatus } from "@/core/types";
import {
  buildEnvironmentProbeSelectedActorSignature,
  computeAnimationClipTimeSeconds,
  computeActorObjectVisibility
} from "@/render/sceneController";

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

function createCurveActor(): ActorNode {
  return {
    id: "actor.curve",
    name: "Curve",
    kind: "actor",
    actorType: "curve",
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
      kind: "spline",
      closed: false,
      points: []
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

describe("computeAnimationClipTimeSeconds", () => {
  test("wraps looping animations against simulation time", () => {
    expect(computeAnimationClipTimeSeconds(3.5, 1, 0, 2, true)).toBeCloseTo(1.5, 6);
    expect(computeAnimationClipTimeSeconds(0.5, 2, 0.25, 2, true)).toBeCloseTo(1.25, 6);
  });

  test("clamps non-looping animations", () => {
    expect(computeAnimationClipTimeSeconds(10, 1, 0, 2, false)).toBeCloseTo(2, 6);
    expect(computeAnimationClipTimeSeconds(-2, 1, 0, 2, false)).toBeCloseTo(0, 6);
  });
});

describe("computeActorObjectVisibility", () => {
  test("hides curve actors when debug helpers are disabled", () => {
    expect(computeActorObjectVisibility(createCurveActor(), false, false)).toBe(false);
    expect(computeActorObjectVisibility(createCurveActor(), false, true)).toBe(true);
  });

  test("keeps standard actor visibility independent of debug helper state", () => {
    expect(computeActorObjectVisibility(createMeshActor(), false, false)).toBe(true);
    expect(computeActorObjectVisibility(createMeshActor(), false, true)).toBe(true);
  });

  test("still respects actor visibility mode for debug-only actors", () => {
    const curve = {
      ...createCurveActor(),
      visibilityMode: "selected" as const
    };
    expect(computeActorObjectVisibility(curve, false, true)).toBe(false);
    expect(computeActorObjectVisibility(curve, true, true)).toBe(true);
  });
});

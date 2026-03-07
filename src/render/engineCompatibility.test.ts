import { describe, expect, test } from "vitest";
import type { ActorNode } from "@/core/types";
import { incompatibilityReason } from "@/render/engineCompatibility";

function createActor(overrides: Partial<ActorNode>): ActorNode {
  return {
    id: "actor.test",
    name: "Test Actor",
    enabled: true,
    kind: "actor",
    actorType: "plugin",
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
    params: {},
    ...overrides
  };
}

describe("engine compatibility", () => {
  test("marks Beam Crossover ghost mode incompatible with WebGPU", () => {
    const actor = createActor({
      pluginType: "plugin.beamCrossover.emitter",
      params: {
        beamType: "ghost"
      }
    });
    expect(incompatibilityReason(actor, "webgpu")).toBe("Beam Crossover ghost mode currently requires WebGL2.");
  });

  test("keeps Beam Crossover solid mode compatible with WebGPU", () => {
    const actor = createActor({
      pluginType: "plugin.beamCrossover.emitterArray",
      params: {
        beamType: "solid"
      }
    });
    expect(incompatibilityReason(actor, "webgpu")).toBeNull();
  });

  test("marks Beam Crossover Scattering Shell mode incompatible with WebGPU", () => {
    const actor = createActor({
      pluginType: "plugin.beamCrossover.emitterArray",
      params: {
        beamType: "scatteringShell"
      }
    });
    expect(incompatibilityReason(actor, "webgpu")).toBe("Beam Crossover Scattering Shell mode currently requires WebGL2.");
  });
});

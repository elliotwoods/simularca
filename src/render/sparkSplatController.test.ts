import { describe, expect, it } from "vitest";
import type { ActorNode, ParameterValues } from "@/core/types";
import { applySparkStochasticDepthMode, isSparkStochasticDepthEnabled } from "@/render/sparkSplatController";

function createActor(params: ParameterValues): ActorNode {
  return {
    id: "actor.spark",
    name: "Spark",
    enabled: true,
    kind: "actor",
    actorType: "gaussian-splat-spark",
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
    params
  };
}

describe("spark stochastic depth helpers", () => {
  it("treats the actor toggle as disabled by default", () => {
    expect(isSparkStochasticDepthEnabled(createActor({}))).toBe(false);
  });

  it("reads the actor toggle when enabled", () => {
    expect(isSparkStochasticDepthEnabled(createActor({ stochasticDepth: true }))).toBe(true);
  });

  it("applies stochastic depth to Spark viewpoints and material state", () => {
    const mesh = {
      defaultView: { stochastic: false },
      viewpoint: { stochastic: false },
      prepareViewpoint: () => undefined,
      material: {
        transparent: true,
        depthWrite: false,
        needsUpdate: false
      }
    };

    applySparkStochasticDepthMode(mesh, true);

    expect(mesh.defaultView.stochastic).toBe(true);
    expect(mesh.viewpoint.stochastic).toBe(true);
    expect(mesh.material.transparent).toBe(false);
    expect(mesh.material.depthWrite).toBe(true);
    expect(mesh.material.needsUpdate).toBe(true);
  });

  it("restores alpha-blended mode when stochastic depth is disabled", () => {
    const mesh = {
      defaultView: { stochastic: true },
      viewpoint: { stochastic: true },
      prepareViewpoint: () => undefined,
      material: {
        transparent: false,
        depthWrite: true,
        needsUpdate: false
      }
    };

    applySparkStochasticDepthMode(mesh, false);

    expect(mesh.defaultView.stochastic).toBe(false);
    expect(mesh.viewpoint.stochastic).toBe(false);
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.needsUpdate).toBe(true);
  });
});

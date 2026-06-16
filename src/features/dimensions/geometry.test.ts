import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ActorNode } from "@/core/types";
import { computeDimensionWorldGeometry } from "@/features/dimensions/geometry";

function dimensionActor(params: Record<string, unknown>): ActorNode {
  return {
    id: "dim-1",
    name: "Dim",
    actorType: "dimension",
    enabled: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    params
  } as unknown as ActorNode;
}

const noObjects = () => null;

describe("computeDimensionWorldGeometry", () => {
  it("offsets an axis-aligned measure by the extension gap", () => {
    const geom = computeDimensionWorldGeometry(
      dimensionActor({
        start: { kind: "world", point: [0, 0, 0] },
        end: { kind: "world", point: [2, 0, 0] },
        axis: "x"
      }),
      noObjects
    );
    expect(geom).not.toBeNull();
    // Default extension gap 0.25 pushes the measure line up the +Y perpendicular.
    expect(geom!.m1.toArray()).toEqual([0, 0.25, 0]);
    expect(geom!.m2.toArray()).toEqual([2, 0.25, 0]);
    expect(geom!.distance).toBeCloseTo(2);
    expect(geom!.labelPos.toArray()).toEqual([1, 0.25, 0]);
  });

  it("measures the direct euclidean distance for a direct axis", () => {
    const geom = computeDimensionWorldGeometry(
      dimensionActor({
        start: { kind: "world", point: [0, 0, 0] },
        end: { kind: "world", point: [3, 4, 0] },
        axis: "direct"
      }),
      noObjects
    );
    expect(geom).not.toBeNull();
    expect(geom!.distance).toBeCloseTo(5);
    expect(geom!.labelPos.toArray()).toEqual([1.5, 2, 0]);
  });

  it("honours an explicit offset direction and magnitude", () => {
    const geom = computeDimensionWorldGeometry(
      dimensionActor({
        start: { kind: "world", point: [0, 0, 0] },
        end: { kind: "world", point: [0, 0, 4] },
        axis: "z",
        offsetDir: [1, 0, 0],
        extensionGap: 0.5
      }),
      noObjects
    );
    expect(geom).not.toBeNull();
    expect(geom!.m1.toArray()).toEqual([0.5, 0, 0]);
    expect(geom!.m2.toArray()).toEqual([0.5, 0, 4]);
  });

  it("resolves actor-relative landmarks through the object resolver", () => {
    const object = new THREE.Object3D();
    object.position.set(10, 0, 0);
    object.updateMatrixWorld(true);
    const geom = computeDimensionWorldGeometry(
      dimensionActor({
        start: { kind: "origin" },
        end: { kind: "actor", actorId: "mesh", localOffset: [1, 0, 0] },
        axis: "x"
      }),
      (actorId) => (actorId === "mesh" ? object : null)
    );
    expect(geom).not.toBeNull();
    // Origin (0) → actor at world x = 10 + local 1 = 11.
    expect(geom!.distance).toBeCloseTo(11);
  });

  it("returns null when an endpoint cannot be resolved", () => {
    const geom = computeDimensionWorldGeometry(
      dimensionActor({
        start: { kind: "origin" },
        end: { kind: "actor", actorId: "missing", localOffset: [0, 0, 0] },
        axis: "x"
      }),
      noObjects
    );
    expect(geom).toBeNull();
  });
});

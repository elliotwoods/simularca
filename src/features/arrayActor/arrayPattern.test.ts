import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  composeInstanceTransform,
  computeInstanceCount,
  computePlacements,
  readArrayParams,
  type LocalCurveSampler
} from "@/features/arrayActor/arrayPattern";

function positionOf(matrix: THREE.Matrix4): [number, number, number] {
  const p = new THREE.Vector3();
  matrix.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
  return [p.x, p.y, p.z];
}

/** Local -Z axis of an oriented matrix (the pattern "forward" direction). */
function forwardOf(matrix: THREE.Matrix4): THREE.Vector3 {
  const q = new THREE.Quaternion();
  matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q);
}

function expectVecClose(actual: [number, number, number], expected: [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 5);
  expect(actual[1]).toBeCloseTo(expected[1], 5);
  expect(actual[2]).toBeCloseTo(expected[2], 5);
}

describe("readArrayParams", () => {
  it("applies defaults and coerces", () => {
    const p = readArrayParams({});
    expect(p.pattern).toBe("linear");
    expect(p.linearCount).toBe(5);
    expect(p.circularFaceOutward).toBe(true);
  });

  it("ignores invalid values", () => {
    const p = readArrayParams({ pattern: "bogus", linearCount: Number.NaN, circularAxis: "w" });
    expect(p.pattern).toBe("linear");
    expect(p.linearCount).toBe(5);
    expect(p.circularAxis).toBe("y");
  });
});

describe("linear placements", () => {
  it("centers the span on the origin", () => {
    const p = readArrayParams({ pattern: "linear", linearCount: 5, linearExtent: [4, 0, 0], linearCentered: true });
    const placements = computePlacements(p);
    expect(placements).toHaveLength(5);
    expectVecClose(positionOf(placements[0]!), [-2, 0, 0]);
    expectVecClose(positionOf(placements[2]!), [0, 0, 0]);
    expectVecClose(positionOf(placements[4]!), [2, 0, 0]);
  });

  it("grows from the origin when not centered", () => {
    const p = readArrayParams({ pattern: "linear", linearCount: 5, linearExtent: [4, 0, 0], linearCentered: false });
    const placements = computePlacements(p);
    expectVecClose(positionOf(placements[0]!), [0, 0, 0]);
    expectVecClose(positionOf(placements[4]!), [4, 0, 0]);
  });

  it("places a single instance at the origin", () => {
    const placements = computePlacements(readArrayParams({ pattern: "linear", linearCount: 1, linearExtent: [4, 0, 0] }));
    expect(placements).toHaveLength(1);
    expectVecClose(positionOf(placements[0]!), [0, 0, 0]);
  });

  it("uses per-step spacing when sized by Spacing", () => {
    const p = readArrayParams({
      pattern: "linear",
      linearCount: 5,
      linearSizing: "Spacing",
      linearSpacing: [1, 0, 0],
      linearCentered: true
    });
    const placements = computePlacements(p);
    expect(placements).toHaveLength(5);
    expectVecClose(positionOf(placements[0]!), [-2, 0, 0]);
    expectVecClose(positionOf(placements[1]!), [-1, 0, 0]);
    expectVecClose(positionOf(placements[4]!), [2, 0, 0]);
  });

  it("never orients linear instances", () => {
    const placements = computePlacements(readArrayParams({ pattern: "linear", linearCount: 3, linearExtent: [3, 0, 0] }));
    for (const m of placements) {
      const q = new THREE.Quaternion();
      m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    }
  });
});

describe("grid placements", () => {
  it("produces nx*ny*nz instances, centered, in deterministic order", () => {
    const p = readArrayParams({
      pattern: "grid",
      gridCountX: 3,
      gridCountY: 1,
      gridCountZ: 2,
      gridSize: [1, 1, 1],
      gridCentered: true
    });
    const placements = computePlacements(p);
    expect(placements).toHaveLength(6);
    // ix outer, iy, iz inner. First = (ix0,iz0): x=-1, z=-0.5
    expectVecClose(positionOf(placements[0]!), [-1, 0, -0.5]);
    expectVecClose(positionOf(placements[1]!), [-1, 0, 0.5]);
    expectVecClose(positionOf(placements[5]!), [1, 0, 0.5]);
  });

  it("offsets from the origin when not centered", () => {
    const p = readArrayParams({
      pattern: "grid",
      gridCountX: 2,
      gridCountY: 1,
      gridCountZ: 1,
      gridSize: [2, 2, 2],
      gridCentered: false
    });
    const placements = computePlacements(p);
    expectVecClose(positionOf(placements[0]!), [0, 0, 0]);
    expectVecClose(positionOf(placements[1]!), [2, 0, 0]);
  });

  it("derives per-axis spacing from extent when sized by Extents", () => {
    const p = readArrayParams({
      pattern: "grid",
      gridCountX: 3,
      gridCountY: 1,
      gridCountZ: 1,
      gridSizing: "Extents",
      gridExtent: [4, 0, 0],
      gridCentered: true
    });
    const placements = computePlacements(p);
    expect(placements).toHaveLength(3);
    // Extent 4 over 3 instances => spacing 2, centered about the origin.
    expectVecClose(positionOf(placements[0]!), [-2, 0, 0]);
    expectVecClose(positionOf(placements[1]!), [0, 0, 0]);
    expectVecClose(positionOf(placements[2]!), [2, 0, 0]);
  });
});

describe("circular placements", () => {
  it("spreads a full circle without a seam duplicate", () => {
    const p = readArrayParams({
      pattern: "circular",
      circularCount: 4,
      circularRadius: 2,
      circularAxis: "y",
      circularArcStartDeg: 0,
      circularArcEndDeg: 360,
      circularFaceOutward: false
    });
    const placements = computePlacements(p);
    expect(placements).toHaveLength(4);
    expectVecClose(positionOf(placements[0]!), [2, 0, 0]);
    expectVecClose(positionOf(placements[1]!), [0, 0, 2]);
    expectVecClose(positionOf(placements[2]!), [-2, 0, 0]);
    expectVecClose(positionOf(placements[3]!), [0, 0, -2]);
  });

  it("includes both endpoints of a partial arc", () => {
    const p = readArrayParams({
      pattern: "circular",
      circularCount: 3,
      circularRadius: 1,
      circularAxis: "y",
      circularArcStartDeg: 0,
      circularArcEndDeg: 90,
      circularFaceOutward: false
    });
    const placements = computePlacements(p);
    expectVecClose(positionOf(placements[0]!), [1, 0, 0]);
    expectVecClose(positionOf(placements[2]!), [0, 0, 1]);
  });

  it("faces outward when enabled", () => {
    const p = readArrayParams({
      pattern: "circular",
      circularCount: 4,
      circularRadius: 2,
      circularAxis: "y",
      circularFaceOutward: true
    });
    const placements = computePlacements(p);
    for (const m of placements) {
      const pos = new THREE.Vector3(...positionOf(m)).normalize();
      const forward = forwardOf(m).normalize();
      expect(forward.dot(pos)).toBeCloseTo(1, 5);
    }
  });
});

describe("along-curve placements", () => {
  const straightLine: LocalCurveSampler = (t) => ({ position: [t * 10, 0, 0], tangent: [1, 0, 0] });

  it("returns nothing without a sampler", () => {
    expect(computePlacements(readArrayParams({ pattern: "along-curve", curveCount: 5 }))).toHaveLength(0);
  });

  it("distributes evenly along the curve range", () => {
    const p = readArrayParams({ pattern: "along-curve", curveCount: 5, curveTStart: 0, curveTEnd: 1 });
    const placements = computePlacements(p, straightLine);
    expect(placements).toHaveLength(5);
    expectVecClose(positionOf(placements[0]!), [0, 0, 0]);
    expectVecClose(positionOf(placements[4]!), [10, 0, 0]);
  });

  it("orients to the tangent when enabled", () => {
    const p = readArrayParams({ pattern: "along-curve", curveCount: 3, curveOrientToTangent: true });
    const placements = computePlacements(p, straightLine);
    for (const m of placements) {
      const forward = forwardOf(m).normalize();
      expect(forward.dot(new THREE.Vector3(1, 0, 0))).toBeCloseTo(1, 5);
    }
  });
});

describe("computeInstanceCount", () => {
  it("multiplies grid counts", () => {
    expect(
      computeInstanceCount(readArrayParams({ pattern: "grid", gridCountX: 3, gridCountY: 2, gridCountZ: 4 }))
    ).toBe(24);
  });
});

describe("composeInstanceTransform", () => {
  it("layers the template's own local transform on top of the placement", () => {
    const placement = new THREE.Matrix4().makeTranslation(5, 0, 0);
    const result = composeInstanceTransform(placement, {
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    });
    expectVecClose(result.position, [5, 1, 0]);
    expectVecClose(result.scale, [1, 1, 1]);
  });

  it("round-trips a rotated/scaled template", () => {
    const placement = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const result = composeInstanceTransform(placement, {
      position: [2, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2]
    });
    // The template sits at +X(2); rotating 90° about Y maps +X -> -Z.
    expectVecClose(result.position, [0, 0, -2]);
    expectVecClose(result.scale, [2, 2, 2]);
  });
});

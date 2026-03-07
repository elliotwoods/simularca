import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  beamEmitterArrayDescriptor,
  beamEmitterDescriptor
} from "../../../plugins/beam-crossover-plugin/src/beamPlugin";
import {
  buildBeamGeometryWorld,
  computeSilhouetteWorld,
  sampleArcLengthCurveTs
} from "../../../plugins/beam-crossover-plugin/src/index";

describe("beam crossover plugin descriptors", () => {
  test("exports beam emitter descriptors with expected schema", () => {
    expect(beamEmitterDescriptor.spawn?.pluginType).toBe("plugin.beamCrossover.emitter");
    expect(beamEmitterArrayDescriptor.spawn?.pluginType).toBe("plugin.beamCrossover.emitterArray");
    expect(beamEmitterArrayDescriptor.schema.params.some((param) => param.key === "emitterCurveId")).toBe(true);
    expect(beamEmitterArrayDescriptor.schema.params.some((param) => param.key === "targetActorId")).toBe(true);
    const beamAlpha = beamEmitterDescriptor.schema.params.find((param) => param.key === "beamAlpha");
    expect(beamAlpha?.visibleWhen).toEqual([{ key: "beamType", equals: "solid" }]);
  });
});

describe("beam crossover silhouette math", () => {
  test("builds a non-uniform sphere silhouette with requested contour count", () => {
    const targetWorldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(2, 1, 0.5)
    );
    const silhouette = computeSilhouetteWorld({
      shape: "sphere",
      dimensions: {
        cubeSize: 1,
        sphereRadius: 1,
        cylinderRadius: 0.5,
        cylinderHeight: 1
      },
      targetWorldMatrix,
      emitterWorld: new THREE.Vector3(0, 0, 5),
      resolution: 24
    });
    expect(silhouette.ok).toBe(true);
    expect(silhouette.contourWorld).toHaveLength(24);
    const inverse = targetWorldMatrix.clone().invert();
    for (const point of silhouette.contourWorld) {
      const local = point.clone().applyMatrix4(inverse);
      expect(local.length()).toBeCloseTo(1, 3);
    }
  });

  test("uses the top cap for an axial-above cylinder view", () => {
    const silhouette = computeSilhouetteWorld({
      shape: "cylinder",
      dimensions: {
        cubeSize: 1,
        sphereRadius: 1,
        cylinderRadius: 0.5,
        cylinderHeight: 2
      },
      targetWorldMatrix: new THREE.Matrix4().identity(),
      emitterWorld: new THREE.Vector3(0, 3, 0),
      resolution: 16
    });
    expect(silhouette.ok).toBe(true);
    for (const point of silhouette.contourWorld) {
      expect(point.y).toBeCloseTo(1, 3);
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(0.5, 3);
    }
  });

  test("rejects an emitter inside a primitive", () => {
    const silhouette = computeSilhouetteWorld({
      shape: "cube",
      dimensions: {
        cubeSize: 2,
        sphereRadius: 1,
        cylinderRadius: 0.5,
        cylinderHeight: 1
      },
      targetWorldMatrix: new THREE.Matrix4().identity(),
      emitterWorld: new THREE.Vector3(0.1, 0.1, 0.1),
      resolution: 12
    });
    expect(silhouette.ok).toBe(false);
    expect(silhouette.reason).toMatch(/inside|on the target primitive/i);
  });

  test("builds a triangle fan with one triangle per contour sample", () => {
    const emitterWorld = new THREE.Vector3(0, 0, 0);
    const contourWorld = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0)
    ];
    const geometry = buildBeamGeometryWorld(emitterWorld, contourWorld, 5, new THREE.Matrix4().identity());
    expect(geometry.getAttribute("position").count).toBe(5);
    expect(geometry.getIndex()?.count).toBe(12);
  });
});

describe("beam crossover curve placement", () => {
  test("places open-curve emitters including both ends", () => {
    const ts = sampleArcLengthCurveTs(
      3,
      false,
      (t) => new THREE.Vector3(t * 10, 0, 0),
      64
    );
    expect(ts[0]).toBeCloseTo(0, 5);
    expect(ts[1]).toBeCloseTo(0.5, 2);
    expect(ts[2]).toBeCloseTo(1, 5);
  });

  test("places closed-curve emitters without duplicating the seam", () => {
    const ts = sampleArcLengthCurveTs(
      4,
      true,
      (t) => new THREE.Vector3(Math.cos(t * Math.PI * 2), Math.sin(t * Math.PI * 2), 0),
      256
    );
    expect(ts).toHaveLength(4);
    expect(new Set(ts.map((value) => value.toFixed(3))).size).toBe(4);
    expect(Math.max(...ts)).toBeLessThan(1);
  });
});

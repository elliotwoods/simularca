import * as THREE from "three";
import { describe, expect, test } from "vitest";
import type { ActorNode, AppState } from "../../../plugins/beam-crossover-plugin/src/contracts";
import {
  beamEmitterArrayDescriptor,
  beamEmitterDescriptor,
  computeGhostAlpha,
  computeScatteringShell2Visibility,
  computeScatteringShellVisibility
} from "../../../plugins/beam-crossover-plugin/src/beamPlugin";
import {
  buildBeamGeometryWorld,
  computeSilhouetteWorld,
  sampleArcLengthCurveTs
} from "../../../plugins/beam-crossover-plugin/src/index";

function makePluginActor(id: string, name: string, pluginType: string, beamType: string): ActorNode {
  return {
    id,
    name,
    enabled: true,
    actorType: "plugin",
    pluginType,
    parentActorId: null,
    childActorIds: [],
    componentIds: [],
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params: { beamType }
  };
}

const emptyPluginState: AppState = { actors: {} };

describe("beam crossover plugin descriptors", () => {
  test("exports beam emitter descriptors with expected schema", () => {
    expect(beamEmitterDescriptor.spawn?.pluginType).toBe("plugin.beamCrossover.emitter");
    expect(beamEmitterArrayDescriptor.spawn?.pluginType).toBe("plugin.beamCrossover.emitterArray");
    expect(beamEmitterArrayDescriptor.schema.params.some((param) => param.key === "emitterCurveId")).toBe(true);
    expect(beamEmitterArrayDescriptor.schema.params.some((param) => param.key === "targetActorId")).toBe(true);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "mistVolumeActorId")).toMatchObject({
      type: "actor-ref",
      allowedActorTypes: ["mist-volume"]
    });
    expect(beamEmitterArrayDescriptor.schema.params.find((param) => param.key === "mistVolumeActorId")).toMatchObject({
      type: "actor-ref",
      allowedActorTypes: ["mist-volume"]
    });
    const beamType = beamEmitterDescriptor.schema.params.find((param) => param.key === "beamType");
    expect(beamType?.options).toEqual(["solid", "ghost", "normals", "scatteringShell", "scatteringShell2"]);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "alongBeamPower")?.defaultValue).toBe(2);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "scatteringFactor")?.defaultValue).toBe(0.25);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "hazeIntensity")?.defaultValue).toBe(1);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "extinctionCoeff")?.defaultValue).toBe(0.05);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "anisotropyG")?.defaultValue).toBe(0.6);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "beamDivergenceRad")?.defaultValue).toBe(0.001);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "beamApertureDiameter")?.defaultValue).toBe(0.002);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "softClampKnee")?.defaultValue).toBe(0.25);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "hazeIntensity")?.description).toContain("visible atmospheric haze");
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "scatteringFactor")?.description).toContain("stage haze about 0.2 to 0.35");
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "scatteringFactor")?.description).toContain("water fog about 0.8 to 1.2");
    expect(beamEmitterDescriptor.schema.params.some((param) => param.key === "travelGain")).toBe(false);
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "beamAlpha")?.description).toContain("final shell intensity");
    expect(beamEmitterDescriptor.schema.params.find((param) => param.key === "mistVolumeActorId")?.description).toContain("only affects Scattering Shell and Scattering Shell 2");
    expect(beamEmitterArrayDescriptor.schema.params.find((param) => param.key === "mistVolumeActorId")?.description).toContain("only affects Scattering Shell and Scattering Shell 2");
  });

  test("reports mist support as shell-mode-only in status", () => {
    const solidStatus = beamEmitterDescriptor.status?.build({
      actor: makePluginActor("beam-solid", "Beam Solid", "plugin.beamCrossover.emitter", "solid"),
      state: emptyPluginState,
      runtimeStatus: {
        values: { mistVolumeName: "Fog Box" },
        updatedAtIso: "2026-03-08T00:00:00.000Z"
      }
    });
    const shellStatus = beamEmitterArrayDescriptor.status?.build({
      actor: makePluginActor("beam-shell", "Beam Shell", "plugin.beamCrossover.emitterArray", "scatteringShell2"),
      state: emptyPluginState,
      runtimeStatus: {
        values: { mistVolumeName: "Fog Box" },
        updatedAtIso: "2026-03-08T00:00:00.000Z"
      }
    });

    expect(solidStatus?.find((entry) => entry.label === "Mist Applies In")?.value).toBe("Scattering Shell, Scattering Shell 2");
    expect(solidStatus?.find((entry) => entry.label === "Mist Active")?.value).toBe(false);
    expect(shellStatus?.find((entry) => entry.label === "Mist Applies In")?.value).toBe("Scattering Shell, Scattering Shell 2");
    expect(shellStatus?.find((entry) => entry.label === "Mist Active")?.value).toBe(true);
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

  test("builds explicit triangles with flat face normals", () => {
    const emitterWorld = new THREE.Vector3(0, 0, 0);
    const contourWorld = [
      new THREE.Vector3(0, 0.5, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, -0.5, -1),
      new THREE.Vector3(-1, 0.25, 0)
    ];
    const geometry = buildBeamGeometryWorld(emitterWorld, contourWorld, 5, new THREE.Matrix4().identity());
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const emitterPosition = geometry.getAttribute("beamEmitterPosition");
    expect(position.count).toBe(12);
    expect(normal?.count).toBe(12);
    expect(emitterPosition?.count).toBe(12);
    expect(geometry.getIndex()).toBeNull();
    expect(position.getX(0)).toBeCloseTo(position.getX(3), 6);
    expect(position.getY(0)).toBeCloseTo(position.getY(3), 6);
    expect(position.getZ(0)).toBeCloseTo(position.getZ(3), 6);
    expect(normal?.getX(0)).toBeCloseTo(normal?.getX(1) ?? 0, 6);
    expect(normal?.getY(0)).toBeCloseTo(normal?.getY(1) ?? 0, 6);
    expect(normal?.getZ(0)).toBeCloseTo(normal?.getZ(1) ?? 0, 6);
    expect(normal?.getX(0)).toBeCloseTo(normal?.getX(2) ?? 0, 6);
    expect(normal?.getY(0)).toBeCloseTo(normal?.getY(2) ?? 0, 6);
    expect(normal?.getZ(0)).toBeCloseTo(normal?.getZ(2) ?? 0, 6);
    expect(emitterPosition?.getX(0)).toBeCloseTo(0, 6);
    expect(emitterPosition?.getY(0)).toBeCloseTo(0, 6);
    expect(emitterPosition?.getZ(0)).toBeCloseTo(0, 6);
  });
});

describe("beam crossover ghost alpha", () => {
  test("returns zero alpha when view and normal are parallel", () => {
    const alpha = computeGhostAlpha(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), 0.6);
    expect(alpha).toBeCloseTo(0, 6);
  });

  test("returns full alpha when view and normal are orthogonal", () => {
    const alpha = computeGhostAlpha(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 0.6);
    expect(alpha).toBeCloseTo(0.6, 6);
  });

  test("scales intermediate ghost alpha by beam alpha", () => {
    const alpha = computeGhostAlpha(new THREE.Vector3(1, 0, 1), new THREE.Vector3(0, 0, 1), 0.5);
    expect(alpha).toBeCloseTo(0.5 * Math.sqrt(0.5), 6);
  });
});

describe("beam crossover scattering shell", () => {
  test("increases path-length term at grazing angles", () => {
    const faceOn = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(0, 0, 1),
      cameraPos: new THREE.Vector3(0, 0, 3),
      beamAlpha: 1,
      hazeIntensity: 1,
      scatteringCoeff: 1,
      extinctionCoeff: 0,
      anisotropyG: 0,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 1,
      pathLengthExponent: 2,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 0,
      nearFadeEnd: 0,
      softClampKnee: 0
    });
    const grazing = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 3),
      beamAlpha: 1,
      hazeIntensity: 1,
      scatteringCoeff: 1,
      extinctionCoeff: 0,
      anisotropyG: 0,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 1,
      pathLengthExponent: 2,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 0,
      nearFadeEnd: 0,
      softClampKnee: 0
    });
    expect(grazing.pathLengthTerm).toBeGreaterThan(faceOn.pathLengthTerm);
  });

  test("uses a fixed normal-view brightness rule from 1.0 at silhouette to 0.5 face-on", () => {
    const silhouette = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      hazeIntensity: 1,
      scatteringCoeff: 1,
      extinctionCoeff: 0,
      anisotropyG: 0,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 0,
      pathLengthExponent: 1,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 0,
      nearFadeEnd: 0,
      softClampKnee: 0
    });
    const faceOn = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(0, 0, 1),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      hazeIntensity: 1,
      scatteringCoeff: 1,
      extinctionCoeff: 0,
      anisotropyG: 0,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 0,
      pathLengthExponent: 1,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 0,
      nearFadeEnd: 0,
      softClampKnee: 0
    });
    expect(silhouette.normalViewTerm).toBeCloseTo(1, 6);
    expect(faceOn.normalViewTerm).toBeCloseTo(0.5, 6);
  });

  test("applies extinction, near fade, and soft clamp to visibility", () => {
    const withoutClamp = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 2),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 6),
      beamAlpha: 1,
      hazeIntensity: 10,
      scatteringCoeff: 5,
      extinctionCoeff: 0,
      anisotropyG: 0.6,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 2,
      pathLengthExponent: 2,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 0,
      nearFadeEnd: 0,
      softClampKnee: 0
    });
    const clampedAndFaded = computeScatteringShellVisibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 2),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 6),
      beamAlpha: 1,
      hazeIntensity: 10,
      scatteringCoeff: 5,
      extinctionCoeff: 0.5,
      anisotropyG: 0.6,
      beamDivergenceRad: 0.001,
      beamApertureDiameter: 0.002,
      distanceFalloffExponent: 0,
      pathLengthGain: 2,
      pathLengthExponent: 2,
      phaseGain: 1,
      scanDuty: 1,
      nearFadeStart: 1,
      nearFadeEnd: 3,
      softClampKnee: 0.25
    });
    expect(clampedAndFaded.extinctionTerm).toBeLessThan(withoutClamp.extinctionTerm);
    expect(clampedAndFaded.nearFadeTerm).toBeLessThan(1);
    expect(clampedAndFaded.visibility).toBeLessThan(withoutClamp.visibility);
  });
});

describe("beam crossover scattering shell 2", () => {
  test("is brightest at silhouette and darkest face-on", () => {
    const silhouette = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 1,
      scatteringFactor: 1
    });
    const faceOn = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(0, 0, 1),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 1,
      scatteringFactor: 1
    });
    expect(silhouette.alongBeamShapeFactor).toBeCloseTo(1, 6);
    expect(faceOn.alongBeamShapeFactor).toBeCloseTo(0, 6);
    expect(silhouette.visibility).toBeGreaterThan(faceOn.visibility);
  });

  test("higher along-beam power narrows the response", () => {
    const lowPower = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 1).normalize(),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 1,
      scatteringFactor: 1
    });
    const highPower = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 1).normalize(),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 4,
      scatteringFactor: 1
    });
    expect(highPower.alongBeamShapeFactor).toBeLessThan(lowPower.alongBeamShapeFactor);
  });

  test("distance factor falls with distance and clamps near the emitter", () => {
    const near = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 0.01),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 1,
      scatteringFactor: 1
    });
    const far = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 2),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 1,
      alongBeamPower: 1,
      scatteringFactor: 1
    });
    expect(near.distanceFactor).toBeCloseTo(10, 6);
    expect(far.distanceFactor).toBeCloseTo(0.5, 6);
    expect(near.distanceFactor).toBeGreaterThan(far.distanceFactor);
  });

  test("scattering factor scales visibility linearly", () => {
    const base = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 0.5,
      alongBeamPower: 2,
      scatteringFactor: 0.25
    });
    const doubled = computeScatteringShell2Visibility({
      emitterPos: new THREE.Vector3(0, 0, 0),
      worldPos: new THREE.Vector3(0, 0, 1),
      worldNormal: new THREE.Vector3(1, 0, 0),
      cameraPos: new THREE.Vector3(0, 0, 5),
      beamAlpha: 0.5,
      alongBeamPower: 2,
      scatteringFactor: 0.5
    });
    expect(doubled.visibility).toBeCloseTo(base.visibility * 2, 6);
    expect(doubled.alpha).toBeCloseTo(base.alpha * 2, 6);
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

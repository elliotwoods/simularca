import { describe, expect, it } from "vitest";
import type { ActorNode } from "@/core/types";
import {
  computeMistDensityFadeFactor,
  pickMistVolumeQuality,
  runMistCpuSimulationForTest,
  simulateMistCpuInjectionForTest
} from "@/render/mistVolumeController";

function createActor(params: ActorNode["params"]): ActorNode {
  return {
    id: "actor.mist",
    name: "Mist",
    enabled: true,
    kind: "actor",
    actorType: "mist-volume",
    visibilityMode: "visible",
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

describe("pickMistVolumeQuality", () => {
  it("uses interactive settings by default", () => {
    const quality = pickMistVolumeQuality(
      createActor({
        resolutionX: 32,
        resolutionY: 24,
        resolutionZ: 16,
        simulationSubsteps: 1,
        previewRaymarchSteps: 48
      }),
      "interactive"
    );
    expect(quality.resolution).toEqual([32, 24, 16]);
    expect(quality.simulationSubsteps).toBe(1);
    expect(quality.previewRaymarchSteps).toBe(48);
  });

  it("uses export override only when enabled", () => {
    const quality = pickMistVolumeQuality(
      createActor({
        resolutionX: 32,
        resolutionY: 24,
        resolutionZ: 16,
        simulationSubsteps: 1,
        previewRaymarchSteps: 48,
        renderOverrideEnabled: true,
        renderResolutionX: 96,
        renderResolutionY: 72,
        renderResolutionZ: 48,
        renderSimulationSubsteps: 3,
        renderPreviewRaymarchSteps: 120
      }),
      "export"
    );
    expect(quality.resolution).toEqual([96, 72, 48]);
    expect(quality.simulationSubsteps).toBe(3);
    expect(quality.previewRaymarchSteps).toBe(120);
  });
});

describe("simulateMistCpuInjectionForTest", () => {
  it("produces non-zero density and non-zero uploaded bytes for a centered source", () => {
    const result = simulateMistCpuInjectionForTest();
    expect(result.densityRange[1]).toBeGreaterThan(0);
    expect(result.uploadByteRange[1]).toBeGreaterThan(0);
  });
});

describe("runMistCpuSimulationForTest", () => {
  it("keeps an empty field empty", () => {
    const result = runMistCpuSimulationForTest({
      sources: [],
      steps: 12,
      dtSeconds: 1 / 30,
      diffusion: 0.8,
      densityDecay: 0,
      buoyancy: 0,
      velocityDrag: 0,
      initialSpeed: 0,
      threshold: 1e-5
    });
    expect(result.densityRange).toEqual([0, 0]);
    expect(result.totalDensity).toBe(0);
    expect(result.nonZeroFraction).toBe(0);
  });

  it("produces local non-zero density from a single centered emitter after one step", () => {
    const result = runMistCpuSimulationForTest({
      steps: 1,
      dtSeconds: 1 / 30,
      sourceRadius: 0.16,
      injectionRate: 1,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 0,
      densityDecay: 0
    });
    expect(result.densityRange[1]).toBeGreaterThan(0);
    expect(result.centerDensity).toBeGreaterThan(0.01);
    expect(result.nonZeroFraction).toBeGreaterThan(0);
  });

  it("is lossless when fade rate is zero on a static seeded field", () => {
    const result = runMistCpuSimulationForTest({
      resolution: [11, 11, 11],
      sources: [],
      initialDensityBlobs: [{ positionLocal: [0, 0, 0], value: 0.7, radiusCells: 0 }],
      steps: 10,
      dtSeconds: 1 / 30,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 0,
      densityDecay: 0,
      threshold: 1e-6
    });
    expect(result.totalDensity).toBeCloseTo(0.7, 5);
    expect(result.centerDensity).toBeCloseTo(0.7, 5);
    expect(result.stepDiagnostics.at(-1)?.postFadeRange).toEqual([0, 0.7]);
  });

  it("reduces density more strongly for higher fade rates", () => {
    const lowFade = runMistCpuSimulationForTest({
      resolution: [11, 11, 11],
      sources: [],
      initialDensityBlobs: [{ positionLocal: [0, 0, 0], value: 0.8, radiusCells: 0 }],
      steps: 12,
      dtSeconds: 1 / 30,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 0,
      densityDecay: 0.5
    });
    const highFade = runMistCpuSimulationForTest({
      resolution: [11, 11, 11],
      sources: [],
      initialDensityBlobs: [{ positionLocal: [0, 0, 0], value: 0.8, radiusCells: 0 }],
      steps: 12,
      dtSeconds: 1 / 30,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 0,
      densityDecay: 3
    });
    expect(highFade.totalDensity).toBeLessThan(lowFade.totalDensity);
    expect(highFade.centerDensity).toBeLessThan(lowFade.centerDensity);
  });

  it("spreads density to the far field in a closed box", () => {
    const result = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 90,
      dtSeconds: 1 / 30,
      sourceRadius: 0.14,
      injectionRate: 0.45,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 1,
      densityDecay: 0,
      threshold: 1e-4
    });
    expect(result.faceDensity).toBeGreaterThan(1e-3);
    expect(result.cornerDensity).toBeGreaterThan(1e-4);
    expect(result.nonZeroFraction).toBeGreaterThan(0.5);
  });

  it("broadly spreads through a closed box under near-default runtime settings", () => {
    const result = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 180,
      dtSeconds: 1 / 30,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0,
      threshold: 1e-4
    });
    expect(result.nonZeroFraction).toBeGreaterThan(0.9);
    expect(result.faceDensity).toBeGreaterThan(0.05);
    expect(result.cornerDensity).toBeGreaterThan(1e-6);
    expect(result.totalDensity).toBeGreaterThan(100);
  });

  it("eventually fills most of a closed box with mist", () => {
    const result = runMistCpuSimulationForTest({
      resolution: [10, 10, 10],
      steps: 220,
      dtSeconds: 1 / 30,
      sourceRadius: 0.14,
      injectionRate: 0.35,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 1,
      densityDecay: 0,
      threshold: 1e-4
    });
    expect(result.nonZeroFraction).toBeGreaterThanOrEqual(0.95);
    expect(result.cornerDensity).toBeGreaterThan(1e-4);
    expect(result.saturatedFraction).toBeLessThan(0.5);
  });

  it("allows raw internal density to exceed one in a stronger closed-box source case", () => {
    const result = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 120,
      dtSeconds: 1 / 30,
      sourceRadius: 0.12,
      injectionRate: 6,
      initialSpeed: 0,
      buoyancy: 0,
      velocityDrag: 0,
      diffusion: 0.1,
      densityDecay: 0,
      threshold: 1e-4
    });
    expect(result.densityRange[1]).toBeGreaterThan(1);
    expect(result.centerDensity).toBeGreaterThan(1);
  });

  it("vents through a single open top face without behaving like all faces are open", () => {
    const topOpen = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 180,
      dtSeconds: 1 / 30,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0,
      threshold: 1e-4,
      boundaries: { posY: "open" }
    });
    const allOpen = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 180,
      dtSeconds: 1 / 30,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0,
      threshold: 1e-4,
      boundaries: {
        negX: "open",
        posX: "open",
        negY: "open",
        posY: "open",
        negZ: "open",
        posZ: "open"
      }
    });
    expect(topOpen.totalDensity).toBeGreaterThan(allOpen.totalDensity);
    expect(topOpen.nonZeroFraction).toBeGreaterThan(allOpen.nonZeroFraction);
  });

  it("responds directionally to which face is open", () => {
    const topOpen = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 180,
      dtSeconds: 1 / 30,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0,
      threshold: 1e-4,
      boundaries: { posY: "open" }
    });
    const sideOpen = runMistCpuSimulationForTest({
      resolution: [12, 12, 12],
      steps: 180,
      dtSeconds: 1 / 30,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0,
      threshold: 1e-4,
      boundaries: { posX: "open" }
    });
    expect(sideOpen.totalDensity).toBeGreaterThan(topOpen.totalDensity);
    expect(sideOpen.faceDensity).toBeGreaterThan(topOpen.faceDensity);
  });
});

describe("computeMistDensityFadeFactor", () => {
  it("is lossless when the explicit fade rate is zero", () => {
    expect(computeMistDensityFadeFactor(0, 1 / 60)).toBe(1);
  });

  it("decreases density more strongly for higher fade rates", () => {
    expect(computeMistDensityFadeFactor(4, 1)).toBeLessThan(computeMistDensityFadeFactor(1, 1));
  });
});

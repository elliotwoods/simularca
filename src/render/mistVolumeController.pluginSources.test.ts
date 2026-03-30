import { describe, expect, it } from "vitest";
import { collectMistSourcesFromVolumetricRayResourceForTest } from "@/render/mistVolumeController";

describe("collectMistSourcesFromVolumetricRayResourceForTest", () => {
  it("converts weighted volumetric ray resources into bounded mist injection samples", () => {
    const samples = collectMistSourcesFromVolumetricRayResourceForTest({
      kind: "ray-field",
      segments: [
        {
          start: [0, 0, 0],
          end: [0, 0, 1],
          direction: [0, 0, 1],
          length: 1,
          weight: 0.9
        },
        {
          start: [1, 0, 0],
          end: [1, 0, 0.5],
          direction: [0, 0, 1],
          length: 0.5,
          weight: 0.3
        }
      ],
      hitPoints: [[0, 0, 1]],
      suggestedSampleSpacingMeters: 0.25,
      suggestedMaxSamples: 4
    });

    expect(samples).toHaveLength(4);
    expect(samples[0]?.directionLocal).toEqual([0, 0, 1]);
    expect(samples.every((sample) => sample.strength > 0)).toBe(true);
    const totalStrength = samples.reduce((sum, sample) => sum + sample.strength, 0);
    expect(totalStrength).toBeGreaterThan(0.7);
    expect(totalStrength).toBeLessThanOrEqual(1.2);
  });
});

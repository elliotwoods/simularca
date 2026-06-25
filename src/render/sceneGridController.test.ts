import { describe, expect, it } from "vitest";
import { majorFadeForSpacing, minorFadeForSpacing } from "@/render/sceneGridController";

describe("minorFadeForSpacing", () => {
  it("is fully transparent at or below the lower bound", () => {
    expect(minorFadeForSpacing(0)).toBe(0);
    expect(minorFadeForSpacing(2)).toBe(0);
    expect(minorFadeForSpacing(1)).toBe(0);
  });

  it("is fully opaque at or above the upper bound", () => {
    expect(minorFadeForSpacing(12)).toBe(1);
    expect(minorFadeForSpacing(40)).toBe(1);
    expect(minorFadeForSpacing(Infinity)).toBe(1);
  });

  it("fades linearly between the bounds", () => {
    // Bounds are [2, 12] (span 10).
    expect(minorFadeForSpacing(7)).toBeCloseTo(0.5, 6);
    expect(minorFadeForSpacing(4.5)).toBeCloseTo(0.25, 6);
    expect(minorFadeForSpacing(9.5)).toBeCloseTo(0.75, 6);
  });

  it("is monotonic across the fade window", () => {
    let prev = -1;
    for (let px = 0; px <= 16; px += 0.5) {
      const fade = minorFadeForSpacing(px);
      expect(fade).toBeGreaterThanOrEqual(prev);
      prev = fade;
    }
  });

  it("hides minor lines for NaN spacing", () => {
    expect(minorFadeForSpacing(NaN)).toBe(0);
  });
});

describe("majorFadeForSpacing", () => {
  it("dims to the floor at or below the lower bound", () => {
    expect(majorFadeForSpacing(0)).toBe(0.5);
    expect(majorFadeForSpacing(50)).toBe(0.5);
    expect(majorFadeForSpacing(20)).toBe(0.5);
  });

  it("is fully opaque at or above the upper bound", () => {
    expect(majorFadeForSpacing(100)).toBe(1);
    expect(majorFadeForSpacing(500)).toBe(1);
    expect(majorFadeForSpacing(Infinity)).toBe(1);
  });

  it("fades linearly between the bounds", () => {
    // Bounds are [50, 100] (span 50), floor 0.5.
    expect(majorFadeForSpacing(75)).toBeCloseTo(0.75, 6);
    expect(majorFadeForSpacing(62.5)).toBeCloseTo(0.625, 6);
    expect(majorFadeForSpacing(87.5)).toBeCloseTo(0.875, 6);
  });

  it("is monotonic across the fade window", () => {
    let prev = -1;
    for (let px = 0; px <= 120; px += 5) {
      const fade = majorFadeForSpacing(px);
      expect(fade).toBeGreaterThanOrEqual(prev);
      prev = fade;
    }
  });

  it("keeps major lines fully visible for NaN spacing", () => {
    expect(majorFadeForSpacing(NaN)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { minorFadeForSpacing } from "@/render/sceneGridController";

describe("minorFadeForSpacing", () => {
  it("is fully transparent at or below the lower bound", () => {
    expect(minorFadeForSpacing(0)).toBe(0);
    expect(minorFadeForSpacing(4)).toBe(0);
    expect(minorFadeForSpacing(2)).toBe(0);
  });

  it("is fully opaque at or above the upper bound", () => {
    expect(minorFadeForSpacing(12)).toBe(1);
    expect(minorFadeForSpacing(40)).toBe(1);
    expect(minorFadeForSpacing(Infinity)).toBe(1);
  });

  it("fades linearly between the bounds", () => {
    expect(minorFadeForSpacing(8)).toBeCloseTo(0.5, 6);
    expect(minorFadeForSpacing(6)).toBeCloseTo(0.25, 6);
    expect(minorFadeForSpacing(10)).toBeCloseTo(0.75, 6);
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

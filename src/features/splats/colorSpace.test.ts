import { describe, expect, it } from "vitest";
import { applySplatOutputTransform, parseSplatColorInputSpace } from "@/features/splats/colorSpace";

describe("splat output transforms", () => {
  it("accepts Apple Log as an output transform", () => {
    expect(parseSplatColorInputSpace("apple-log")).toBe("apple-log");
  });

  it("defaults unknown values to sRGB", () => {
    expect(parseSplatColorInputSpace("not-a-color-space")).toBe("srgb");
  });

  it("passes linear colors through unchanged", () => {
    expect(applySplatOutputTransform([0.1, 0.2, 0.3], "linear")).toEqual([0.1, 0.2, 0.3]);
  });

  it("encodes linear light into sRGB", () => {
    const [r, g, b] = applySplatOutputTransform([0.214041, 0.214041, 0.214041], "srgb");
    expect(r).toBeCloseTo(0.5, 5);
    expect(g).toBeCloseTo(0.5, 5);
    expect(b).toBeCloseTo(0.5, 5);
  });

  it("encodes linear sRGB into a finite Apple Log triplet", () => {
    const encoded = applySplatOutputTransform([0.58, 0.42, 0.31], "apple-log");
    for (const channel of encoded) {
      expect(Number.isFinite(channel)).toBe(true);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

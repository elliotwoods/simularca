import { describe, expect, it } from "vitest";
import {
  MIN_PERSPECTIVE_PROJECTION_DEPTH,
  clampViewZToPerspectiveNear,
  sanitizeCameraNear
} from "../../../plugins/gaussian-splat-webgpu-plugin/src/projectionDepth";

describe("gaussian splat WebGPU projection depth", () => {
  it("uses the real camera near instead of a hidden 0.2 threshold", () => {
    expect(sanitizeCameraNear(0.01)).toBeCloseTo(0.01, 8);
    expect(clampViewZToPerspectiveNear(-0.05, 0.01)).toBeCloseTo(-0.05, 8);
    expect(clampViewZToPerspectiveNear(-0.005, 0.01)).toBeCloseTo(-0.01, 8);
  });

  it("falls back to a tiny positive epsilon for invalid near values", () => {
    expect(sanitizeCameraNear(0)).toBe(MIN_PERSPECTIVE_PROJECTION_DEPTH);
    expect(sanitizeCameraNear(Number.NaN)).toBe(MIN_PERSPECTIVE_PROJECTION_DEPTH);
    expect(clampViewZToPerspectiveNear(-1e-6, 0)).toBeCloseTo(-MIN_PERSPECTIVE_PROJECTION_DEPTH, 8);
  });
});

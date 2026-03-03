import { describe, expect, it } from "vitest";
import { estimateCurveLength, sampleCurvePosition, sampleCurveTangent } from "@/features/curves/sampler";
import type { CurveData } from "@/features/curves/types";

const curve: CurveData = {
  closed: false,
  points: [
    {
      position: [0, 0, 0],
      handleIn: [-0.25, 0, 0],
      handleOut: [0.25, 0.4, 0],
      mode: "mirrored"
    },
    {
      position: [1, 0, 0],
      handleIn: [-0.25, -0.4, 0],
      handleOut: [0.25, 0, 0],
      mode: "mirrored"
    }
  ]
};

describe("curve sampler", () => {
  it("samples segment endpoints at t=0 and t=1", () => {
    const start = sampleCurvePosition(curve, 0);
    const end = sampleCurvePosition(curve, 1);
    expect(start[0]).toBeCloseTo(0, 6);
    expect(start[1]).toBeCloseTo(0, 6);
    expect(end[0]).toBeCloseTo(1, 6);
    expect(end[1]).toBeCloseTo(0, 6);
  });

  it("returns normalized tangent", () => {
    const tangent = sampleCurveTangent(curve, 0.37);
    const magnitude = Math.hypot(tangent[0], tangent[1], tangent[2]);
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it("estimates positive arc length", () => {
    const low = estimateCurveLength(curve, 8);
    const high = estimateCurveLength(curve, 64);
    expect(low).toBeGreaterThan(1);
    expect(high).toBeGreaterThan(1);
    expect(Math.abs(high - low)).toBeLessThan(0.25);
  });
});

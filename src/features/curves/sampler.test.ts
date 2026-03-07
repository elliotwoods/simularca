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

  it("samples auto-anchor curves using neighbor-informed handles", () => {
    const autoCurve: CurveData = {
      closed: false,
      points: [
        {
          position: [0, 0, 0],
          handleIn: [0, 0, 0],
          handleOut: [0, 0, 0],
          mode: "auto"
        },
        {
          position: [3, 3, 0],
          handleIn: [0, 0, 0],
          handleOut: [0, 0, 0],
          mode: "auto"
        },
        {
          position: [6, 0, 0],
          handleIn: [0, 0, 0],
          handleOut: [0, 0, 0],
          mode: "auto"
        }
      ]
    };

    const midpoint = sampleCurvePosition(autoCurve, 0.5);
    expect(midpoint[0]).toBeCloseTo(3, 6);
    expect(midpoint[1]).toBeCloseTo(3, 6);

    const tangent = sampleCurveTangent(autoCurve, 0.5);
    expect(tangent[0]).toBeCloseTo(1, 6);
    expect(tangent[1]).toBeCloseTo(0, 6);
  });

  it("samples analytic circles in local XY", () => {
    const circle: CurveData = {
      kind: "circle",
      closed: true,
      points: [],
      radius: 2
    };

    expect(sampleCurvePosition(circle, 0)).toEqual([2, 0, 0]);
    const quarter = sampleCurvePosition(circle, 0.25);
    expect(quarter[0]).toBeCloseTo(0, 6);
    expect(quarter[1]).toBeCloseTo(2, 6);
    const half = sampleCurvePosition(circle, 0.5);
    expect(half[0]).toBeCloseTo(-2, 6);
    expect(half[1]).toBeCloseTo(0, 6);

    const tangent = sampleCurveTangent(circle, 0.25);
    expect(tangent[0]).toBeCloseTo(-1, 6);
    expect(tangent[1]).toBeCloseTo(0, 6);
    expect(estimateCurveLength(circle, 24)).toBeCloseTo(Math.PI * 4, 6);
  });
});

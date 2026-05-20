import { describe, expect, it } from "vitest";
import { estimateCurveLength, sampleCurvePosition, sampleCurveTangent } from "@/features/curves/sampler";
import {
  createArcCurveData,
  createHelixCurveData,
  sanitizeCurveData,
  type CurveData
} from "@/features/curves/types";

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

  it("samples arcs with a partial sweep", () => {
    const semicircle = createArcCurveData(2, 0.5);
    expect(semicircle.closed).toBe(false);

    const start = sampleCurvePosition(semicircle, 0);
    expect(start[0]).toBeCloseTo(2, 6);
    expect(start[1]).toBeCloseTo(0, 6);

    const end = sampleCurvePosition(semicircle, 1);
    expect(end[0]).toBeCloseTo(-2, 6);
    expect(end[1]).toBeCloseTo(0, 6);

    // Quarter through a half-sweep = pi/2 angle → (0, 2, 0)
    const quarter = sampleCurvePosition(semicircle, 0.5);
    expect(quarter[0]).toBeCloseTo(0, 6);
    expect(quarter[1]).toBeCloseTo(2, 6);

    expect(estimateCurveLength(semicircle, 24)).toBeCloseTo(Math.PI * 2, 6);

    const fullArc = createArcCurveData(1, 1);
    expect(fullArc.closed).toBe(true);
    expect(estimateCurveLength(fullArc, 24)).toBeCloseTo(Math.PI * 2, 6);
  });

  it("centers arcs symmetrically about the +X axis when arcCentered is set", () => {
    // 60° arc (fraction 1/6) centered about +X: spans -30°..+30°.
    const centered = createArcCurveData(2, 1 / 6, true);
    expect(centered.arcCentered).toBe(true);
    expect(centered.closed).toBe(false);

    const start = sampleCurvePosition(centered, 0);
    expect(start[0]).toBeCloseTo(2 * Math.cos(-Math.PI / 6), 6);
    expect(start[1]).toBeCloseTo(2 * Math.sin(-Math.PI / 6), 6);

    const mid = sampleCurvePosition(centered, 0.5);
    expect(mid[0]).toBeCloseTo(2, 6);
    expect(mid[1]).toBeCloseTo(0, 6);

    const end = sampleCurvePosition(centered, 1);
    expect(end[0]).toBeCloseTo(2 * Math.cos(Math.PI / 6), 6);
    expect(end[1]).toBeCloseTo(2 * Math.sin(Math.PI / 6), 6);

    // Total arc length unchanged when only the start angle shifts.
    expect(estimateCurveLength(centered, 24)).toBeCloseTo((Math.PI * 2 * 2) / 6, 6);
  });

  it("samples helices rising along +Z", () => {
    const helix = createHelixCurveData(1, 1, 2);
    expect(helix.closed).toBe(false);

    const start = sampleCurvePosition(helix, 0);
    expect(start[0]).toBeCloseTo(1, 6);
    expect(start[1]).toBeCloseTo(0, 6);
    expect(start[2]).toBeCloseTo(0, 6);

    // 2 full turns → t=1 returns to (1, 0) in XY, total height = pitch * turns = 2.
    const end = sampleCurvePosition(helix, 1);
    expect(end[0]).toBeCloseTo(1, 6);
    expect(end[1]).toBeCloseTo(0, 6);
    expect(end[2]).toBeCloseTo(2, 6);

    // Length: turns * sqrt((2π r)^2 + pitch^2)
    const expectedLength = 2 * Math.hypot(2 * Math.PI, 1);
    expect(estimateCurveLength(helix, 24)).toBeCloseTo(expectedLength, 6);

    // Tangent should be normalized.
    const tangent = sampleCurveTangent(helix, 0.37);
    expect(Math.hypot(tangent[0], tangent[1], tangent[2])).toBeCloseTo(1, 6);
  });

  it("round-trips arc and helix params through sanitizeCurveData", () => {
    const sanitizedArc = sanitizeCurveData({
      kind: "arc",
      radius: 3,
      arcFraction: 0.25
    });
    expect(sanitizedArc.kind).toBe("arc");
    expect(sanitizedArc.radius).toBe(3);
    expect(sanitizedArc.arcFraction).toBe(0.25);
    expect(sanitizedArc.closed).toBe(false);

    const sanitizedHelix = sanitizeCurveData({
      kind: "helix",
      radius: 1.5,
      helixPitch: 0.4,
      helixTurns: 3
    });
    expect(sanitizedHelix.kind).toBe("helix");
    expect(sanitizedHelix.radius).toBe(1.5);
    expect(sanitizedHelix.helixPitch).toBe(0.4);
    expect(sanitizedHelix.helixTurns).toBe(3);
    expect(sanitizedHelix.closed).toBe(false);

    // Switching kind drops kind-specific extras.
    const switchedToCircle = sanitizeCurveData({ kind: "circle", radius: 2 });
    expect(switchedToCircle.kind).toBe("circle");
    expect(switchedToCircle.arcFraction).toBeUndefined();
    expect(switchedToCircle.helixPitch).toBeUndefined();
    expect(switchedToCircle.helixTurns).toBeUndefined();
  });
});

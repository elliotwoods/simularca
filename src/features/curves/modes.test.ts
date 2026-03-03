import { describe, expect, it } from "vitest";
import { getEffectiveCurveHandles } from "@/features/curves/handles";
import { setCurveHandlePosition, setCurvePointMode } from "@/features/curves/editing";
import { sanitizeCurveData, type CurveData } from "@/features/curves/types";

const curve: CurveData = {
  closed: false,
  points: [
    {
      position: [0, 0, 0],
      handleIn: [-1, 0, 0],
      handleOut: [1, 0, 0],
      mode: "mirrored"
    },
    {
      position: [2, 0, 0],
      handleIn: [-1, 0, 0],
      handleOut: [1, 0, 0],
      mode: "mirrored"
    }
  ]
};

function expectVecClose(actual: [number, number, number] | undefined, expected: [number, number, number]): void {
  expect(actual?.[0]).toBeCloseTo(expected[0], 6);
  expect(actual?.[1]).toBeCloseTo(expected[1], 6);
  expect(actual?.[2]).toBeCloseTo(expected[2], 6);
}

describe("curve handle modes", () => {
  it("maps legacy modes to normal", () => {
    const freeCurve = sanitizeCurveData({
      closed: false,
      points: [{ position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "free" }]
    });
    const alignedCurve = sanitizeCurveData({
      closed: false,
      points: [{ position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "aligned" }]
    });
    expect(freeCurve.points[0]?.mode).toBe("normal");
    expect(alignedCurve.points[0]?.mode).toBe("normal");
  });

  it("mirrored mode keeps handles symmetric while editing", () => {
    const edited = setCurveHandlePosition(curve, 0, "out", [2, 3, 0]);
    expectVecClose(edited.points[0]?.handleOut, [2, 3, 0]);
    expectVecClose(edited.points[0]?.handleIn, [-2, -3, 0]);
  });

  it("normal mode allows independent handles", () => {
    const normalCurve = setCurvePointMode(curve, 0, "normal");
    const edited = setCurveHandlePosition(normalCurve, 0, "out", [3, 0, 0]);
    expectVecClose(edited.points[0]?.handleOut, [3, 0, 0]);
    expectVecClose(edited.points[0]?.handleIn, [-1, 0, 0]);
  });

  it("hard mode keeps stored handles but exposes zero effective handles", () => {
    const hardCurve = setCurvePointMode(curve, 0, "hard");
    const point = hardCurve.points[0];
    expectVecClose(point?.handleIn, [-1, 0, 0]);
    expectVecClose(point?.handleOut, [1, 0, 0]);
    expectVecClose(point ? getEffectiveCurveHandles(point).handleIn : undefined, [0, 0, 0]);
    expectVecClose(point ? getEffectiveCurveHandles(point).handleOut : undefined, [0, 0, 0]);
  });

  it("normal to mirrored symmetrizes using both handles", () => {
    const normalCurve = setCurvePointMode(curve, 0, "normal");
    const withIndependent = setCurveHandlePosition(normalCurve, 0, "in", [-4, 1, 0]);
    const mirrored = setCurvePointMode(withIndependent, 0, "mirrored");
    expectVecClose(mirrored.points[0]?.handleOut, [2.5, -0.5, 0]);
    expectVecClose(mirrored.points[0]?.handleIn, [-2.5, 0.5, 0]);
  });
});

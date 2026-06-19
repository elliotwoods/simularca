import { describe, it, expect } from "vitest";
import {
  beamRadiusAtDistance,
  buildBeamSegments,
  effectiveOutputLumens,
  fieldDiameterAtThrow,
  pointInBeamCone,
  resolveFieldAngleDeg,
  resolveGelHex,
  type BeamCone,
  type BeamParams
} from "./source4Optics";

function baseParams(overrides: Partial<BeamParams> = {}): BeamParams {
  return {
    lensMode: "fixed",
    lensTube: "26°",
    zoomBarrel: "25-50",
    zoomAngleDeg: 36,
    throwDistance: 5,
    previewLength: 5,
    edgeQuality: 0,
    shutterTop: 0,
    shutterBottom: 0,
    shutterLeft: 0,
    shutterRight: 0,
    ...overrides
  };
}

function vertices(data: Float32Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < data.length; i += 3) {
    out.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  return out;
}

describe("resolveFieldAngleDeg", () => {
  it("returns the exact fixed tube angle", () => {
    expect(resolveFieldAngleDeg(baseParams({ lensTube: "26°" }))).toBe(26);
    expect(resolveFieldAngleDeg(baseParams({ lensTube: "50°" }))).toBe(50);
    expect(resolveFieldAngleDeg(baseParams({ lensTube: "5°" }))).toBe(5);
  });

  it("clamps the zoom angle to the selected barrel range", () => {
    expect(resolveFieldAngleDeg(baseParams({ lensMode: "zoom", zoomBarrel: "25-50", zoomAngleDeg: 60 }))).toBe(50);
    expect(resolveFieldAngleDeg(baseParams({ lensMode: "zoom", zoomBarrel: "25-50", zoomAngleDeg: 10 }))).toBe(25);
    expect(resolveFieldAngleDeg(baseParams({ lensMode: "zoom", zoomBarrel: "15-30", zoomAngleDeg: 10 }))).toBe(15);
    expect(resolveFieldAngleDeg(baseParams({ lensMode: "zoom", zoomBarrel: "15-30", zoomAngleDeg: 22 }))).toBe(22);
  });
});

describe("field geometry math", () => {
  it("fieldDiameterAtThrow matches 2*throw*tan(angle/2)", () => {
    const expected = 2 * 5 * Math.tan((26 / 2) * (Math.PI / 180));
    expect(fieldDiameterAtThrow(26, 5)).toBeCloseTo(expected, 6);
    expect(fieldDiameterAtThrow(26, 5)).toBeCloseTo(2.3087, 3);
  });

  it("is monotonic in throw and in angle", () => {
    expect(fieldDiameterAtThrow(26, 10)).toBeGreaterThan(fieldDiameterAtThrow(26, 5));
    expect(fieldDiameterAtThrow(36, 5)).toBeGreaterThan(fieldDiameterAtThrow(26, 5));
  });

  it("beamRadiusAtDistance is zero at the lens and equals fieldDiameter/2 at the throw", () => {
    expect(beamRadiusAtDistance(26, 0)).toBe(0);
    expect(beamRadiusAtDistance(26, 5)).toBeCloseTo(fieldDiameterAtThrow(26, 5) / 2, 9);
  });
});

describe("buildBeamSegments", () => {
  it("emits valid line-segment pairs with apex at origin and boundary at the preview plane", () => {
    const params = baseParams({ previewLength: 4 });
    const data = buildBeamSegments(params);
    expect(data.length % 6).toBe(0);
    expect(data.length).toBeGreaterThan(0);
    const R = beamRadiusAtDistance(26, 4);
    for (const [x, y, z] of vertices(data)) {
      const isApex = Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(z) < 1e-6;
      const onPlane = Math.abs(z - -4) < 1e-6;
      expect(isApex || onPlane).toBe(true);
      if (onPlane) {
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(R + 1e-5);
      }
    }
  });

  it("clips the top of the field when the top shutter is fully in", () => {
    const data = buildBeamSegments(baseParams({ shutterTop: 100 }));
    for (const [, y] of vertices(data)) {
      expect(y).toBeLessThanOrEqual(1e-6);
    }
  });

  it("keeps the full field height when no shutter is inserted", () => {
    const R = beamRadiusAtDistance(26, 5);
    const data = buildBeamSegments(baseParams());
    const maxY = Math.max(...vertices(data).map(([, y]) => y));
    expect(maxY).toBeCloseTo(R, 4);
  });

  it("collapses to nothing when all four shutters are fully in", () => {
    const data = buildBeamSegments(
      baseParams({ shutterTop: 100, shutterBottom: 100, shutterLeft: 100, shutterRight: 100 })
    );
    expect(data.length).toBe(0);
  });

  it("adds a penumbra loop for a soft edge", () => {
    const hard = buildBeamSegments(baseParams({ edgeQuality: 0 }));
    const soft = buildBeamSegments(baseParams({ edgeQuality: 1 }));
    expect(soft.length).toBeGreaterThan(hard.length);
  });

  it("returns nothing for a zero preview length", () => {
    expect(buildBeamSegments(baseParams({ previewLength: 0 })).length).toBe(0);
  });

  it("draws the cone to previewLength, independent of throwDistance", () => {
    const data = buildBeamSegments(baseParams({ throwDistance: 5, previewLength: 20 }));
    const zs = vertices(data).map(([, , z]) => z);
    // Boundary vertices sit at the preview plane (-20), not the throw plane (-5).
    expect(Math.min(...zs)).toBeCloseTo(-20, 6);
    const R = beamRadiusAtDistance(26, 20);
    const maxR = Math.max(...vertices(data).map(([x, y]) => Math.hypot(x, y)));
    expect(maxR).toBeCloseTo(R, 4);
  });
});

describe("pointInBeamCone", () => {
  const cone: BeamCone = {
    position: [0, 0, 0],
    direction: [0, 0, -1],
    cosHalfAngle: Math.cos((20 * Math.PI) / 180), // 40° full field
    range: 10
  };

  it("includes a point straight down the axis within range", () => {
    expect(pointInBeamCone([0, 0, -5], cone)).toBe(true);
  });

  it("excludes a point outside the half-angle", () => {
    expect(pointInBeamCone([6, 0, -5], cone)).toBe(false); // ~50° off-axis
  });

  it("excludes a point beyond the range", () => {
    expect(pointInBeamCone([0, 0, -12], cone)).toBe(false);
  });

  it("excludes a point behind the apex", () => {
    expect(pointInBeamCone([0, 0, 5], cone)).toBe(false);
  });
});

describe("output + gel resolution", () => {
  it("scales lumens by the dimmer", () => {
    expect(effectiveOutputLumens("HPL575", 100)).toBe(16520);
    expect(effectiveOutputLumens("HPL575", 0)).toBe(0);
    expect(effectiveOutputLumens("HPL575", 50)).toBe(8260);
    expect(effectiveOutputLumens("unknown", 100)).toBe(0);
  });

  it("resolves gel mode to a tint intent", () => {
    expect(resolveGelHex("none", "", "")).toMatchObject({ hex: null });
    expect(resolveGelHex("custom", "", "#ff8800")).toMatchObject({ hex: "#ff8800", approximate: false });
    expect(resolveGelHex("preset", "L201", "")).toMatchObject({ approximate: true });
  });
});

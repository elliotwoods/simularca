import { describe, expect, it } from "vitest";
import { buildDxfScene } from "@/features/dxf/dxfToScene";
import { parseDxf } from "@/features/dxf/parseDxf";
import { makePlaneBasis, type ParsedDxfDocument } from "@/features/dxf/dxfTypes";

function makeDocument(entities: ParsedDxfDocument["entities"]): ParsedDxfDocument {
  return {
    layers: [{ name: "0", sourceColor: "#ffffff", order: 0 }],
    entities,
    unsupportedEntityCounts: {},
    warnings: []
  };
}

describe("DXF source-plane handling", () => {
  it("auto-detects YZ source drawings and maps them correctly", () => {
    const document = makeDocument([
      {
        type: "LINE",
        layerName: "0",
        start: [0, 10, 20],
        end: [0, 30, 40]
      }
    ]);

    const built = buildDxfScene(document, {
      inputUnits: "meters",
      sourcePlane: "auto",
      drawingPlane: "front-xy",
      curveResolution: 32,
      invertColors: false,
      showText: true
    });

    expect(built.resolvedSourcePlane).toBe("yz");
    expect(Array.from(built.layers[0]?.linePositions ?? [])).toEqual([10, 20, 0, 30, 40, 0]);
  });

  it("recovers circle extrusion metadata dropped by dxf-parser", () => {
    const source = [
      "0",
      "SECTION",
      "2",
      "ENTITIES",
      "0",
      "CIRCLE",
      "5",
      "10",
      "8",
      "0",
      "10",
      "5",
      "20",
      "7",
      "30",
      "0",
      "40",
      "2",
      "210",
      "1",
      "220",
      "0",
      "230",
      "0",
      "0",
      "ENDSEC",
      "0",
      "EOF"
    ].join("\n");

    const parsed = parseDxf(source);
    const circle = parsed.entities[0];
    expect(circle?.type).toBe("CIRCLE");
    if (circle?.type !== "CIRCLE") {
      throw new Error("Expected parsed circle entity");
    }

    expect(circle.plane.origin[0]).toBeCloseTo(0, 6);
    expect(circle.plane.origin[1]).toBeCloseTo(5, 6);
    expect(circle.plane.origin[2]).toBeCloseTo(7, 6);
  });

  it("flattens planar quadratic splines into linework", () => {
    const document = makeDocument([
      {
        type: "SPLINE",
        layerName: "0",
        degree: 2,
        knotValues: [0, 0, 0, 1, 1, 1],
        controlPoints: [
          [0, 0, 0],
          [0, 10, 10],
          [0, 20, 0]
        ],
        fitPoints: [],
        closed: false,
        planar: true,
        linear: false
      }
    ]);

    const built = buildDxfScene(document, {
      inputUnits: "meters",
      sourcePlane: "yz",
      drawingPlane: "front-xy",
      curveResolution: 24,
      invertColors: false,
      showText: true
    });

    expect(built.segmentCount).toBeGreaterThan(2);
    const positions = Array.from(built.layers[0]?.linePositions ?? []);
    expect(positions.length).toBeGreaterThan(6);
    expect(positions[0]).toBeCloseTo(0, 6);
    expect(positions[1]).toBeCloseTo(0, 6);
    expect(positions[positions.length - 3]).toBeCloseTo(20, 6);
    expect(positions[positions.length - 2]).toBeCloseTo(0, 6);
  });

  it("can project arc-style plane bases from YZ source to target space", () => {
    const document = makeDocument([
      {
        type: "ARC",
        layerName: "0",
        plane: makePlaneBasis([0, 100, 200], [0, 1, 0], [0, 0, 1]),
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);

    const built = buildDxfScene(document, {
      inputUnits: "meters",
      sourcePlane: "auto",
      drawingPlane: "front-xy",
      curveResolution: 16,
      invertColors: false,
      showText: true
    });

    expect(built.resolvedSourcePlane).toBe("yz");
    expect(built.segmentCount).toBeGreaterThan(0);
    expect(built.bounds?.min[0]).toBeGreaterThanOrEqual(100);
    expect(built.bounds?.max[1]).toBeGreaterThanOrEqual(210);
  });
});

describe("DXF snap-point extraction", () => {
  const buildOptions = {
    inputUnits: "meters" as const,
    sourcePlane: "yz" as const,
    drawingPlane: "front-xy" as const,
    curveResolution: 16,
    invertColors: false,
    showText: true
  };

  it("emits both endpoints and the midpoint of a line", () => {
    const built = buildDxfScene(
      makeDocument([{ type: "LINE", layerName: "0", start: [0, 10, 20], end: [0, 30, 40] }]),
      buildOptions
    );
    const layer = built.layers[0];
    expect(Array.from(layer?.snapEndpoints ?? [])).toEqual([10, 20, 0, 30, 40, 0]);
    expect(Array.from(layer?.snapMidpoints ?? [])).toEqual([20, 30, 0]);
    expect(Array.from(layer?.snapCenters ?? [])).toEqual([]);
  });

  it("emits arc endpoints, mid-angle midpoint, and center", () => {
    const built = buildDxfScene(
      makeDocument([
        {
          type: "ARC",
          layerName: "0",
          plane: makePlaneBasis([0, 100, 200], [0, 1, 0], [0, 0, 1]),
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 90
        }
      ]),
      buildOptions
    );
    const layer = built.layers[0];
    const endpoints = Array.from(layer?.snapEndpoints ?? []);
    const midpoints = Array.from(layer?.snapMidpoints ?? []);
    const centers = Array.from(layer?.snapCenters ?? []);
    // Basis projects to [100 + 10·cos θ, 200 + 10·sin θ]; θ = 0 → start, 90° → end, 45° → mid.
    expect(endpoints[0]).toBeCloseTo(110, 6);
    expect(endpoints[1]).toBeCloseTo(200, 6);
    expect(endpoints[3]).toBeCloseTo(100, 6);
    expect(endpoints[4]).toBeCloseTo(210, 6);
    // Float32 storage, so loosen precision for the irrational mid-angle coords.
    expect(midpoints[0]).toBeCloseTo(100 + 10 * Math.cos(Math.PI / 4), 4);
    expect(midpoints[1]).toBeCloseTo(200 + 10 * Math.sin(Math.PI / 4), 4);
    expect(centers).toEqual([100, 200, 0]);
  });

  it("emits only a center for a full circle", () => {
    const built = buildDxfScene(
      makeDocument([{ type: "CIRCLE", layerName: "0", plane: makePlaneBasis([0, 5, 7], [0, 1, 0], [0, 0, 1]), radius: 3 }]),
      buildOptions
    );
    const layer = built.layers[0];
    expect(Array.from(layer?.snapCenters ?? [])).toEqual([5, 7, 0]);
    expect(Array.from(layer?.snapEndpoints ?? [])).toEqual([]);
    expect(Array.from(layer?.snapMidpoints ?? [])).toEqual([]);
  });

  it("emits per-vertex endpoints and per-segment midpoints for an open polyline", () => {
    const built = buildDxfScene(
      makeDocument([
        {
          type: "LWPOLYLINE",
          layerName: "0",
          closed: false,
          vertices: [{ point: [0, 0, 0] }, { point: [0, 10, 0] }, { point: [0, 10, 10] }]
        }
      ]),
      buildOptions
    );
    const layer = built.layers[0];
    expect(Array.from(layer?.snapEndpoints ?? [])).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    expect(Array.from(layer?.snapMidpoints ?? [])).toEqual([5, 0, 0, 10, 5, 0]);
  });
});

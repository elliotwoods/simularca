import type { DxfDrawingPlane, DxfInputUnits, DxfSourcePlane } from "@/core/types";

export interface ParsedDxfBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ParsedDxfLayer {
  name: string;
  sourceColor: string;
  order: number;
}

export interface ParsedDxfPlaneBasis {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  normal: [number, number, number];
}

interface ParsedDxfEntityBase {
  type: string;
  layerName: string;
}

export interface ParsedDxfLineEntity extends ParsedDxfEntityBase {
  type: "LINE";
  start: [number, number, number];
  end: [number, number, number];
}

export interface ParsedDxfSplineEntity extends ParsedDxfEntityBase {
  type: "SPLINE";
  degree: number;
  knotValues: number[];
  controlPoints: Array<[number, number, number]>;
  fitPoints: Array<[number, number, number]>;
  closed: boolean;
  planar: boolean;
  linear: boolean;
}

export interface ParsedDxfPolylineVertex {
  point: [number, number, number];
  bulge?: number;
}

export interface ParsedDxfPolylineEntity extends ParsedDxfEntityBase {
  type: "LWPOLYLINE" | "POLYLINE";
  closed: boolean;
  vertices: ParsedDxfPolylineVertex[];
}

export interface ParsedDxfCircleEntity extends ParsedDxfEntityBase {
  type: "CIRCLE";
  plane: ParsedDxfPlaneBasis;
  radius: number;
}

export interface ParsedDxfArcEntity extends ParsedDxfEntityBase {
  type: "ARC";
  plane: ParsedDxfPlaneBasis;
  radius: number;
  startAngleDeg: number;
  endAngleDeg: number;
}

export interface ParsedDxfEllipseEntity extends ParsedDxfEntityBase {
  type: "ELLIPSE";
  plane: ParsedDxfPlaneBasis;
  majorLength: number;
  minorLength: number;
  startParameter: number;
  endParameter: number;
}

export interface ParsedDxfTextEntity extends ParsedDxfEntityBase {
  type: "TEXT" | "MTEXT";
  text: string;
  position: [number, number, number];
  direction: [number, number, number];
  height: number;
}

export type ParsedDxfEntity =
  | ParsedDxfLineEntity
  | ParsedDxfSplineEntity
  | ParsedDxfPolylineEntity
  | ParsedDxfCircleEntity
  | ParsedDxfArcEntity
  | ParsedDxfEllipseEntity
  | ParsedDxfTextEntity;

export interface ParsedDxfDocument {
  layers: ParsedDxfLayer[];
  entities: ParsedDxfEntity[];
  extents?: ParsedDxfBounds;
  unsupportedEntityCounts: Record<string, number>;
  warnings: string[];
}

export interface DxfBuildOptions {
  inputUnits: DxfInputUnits;
  sourcePlane: DxfSourcePlane;
  drawingPlane: DxfDrawingPlane;
  curveResolution: number;
  invertColors: boolean;
  showText: boolean;
}

export interface DxfLayerGeometry {
  layerName: string;
  sourceColor: string;
  linePositions: Float32Array;
  textItems: DxfTextRenderItem[];
}

export interface DxfTextRenderItem {
  text: string;
  position: [number, number, number];
  rotationRadians: number;
  heightMeters: number;
}

export interface BuiltDxfScene {
  layers: DxfLayerGeometry[];
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  } | null;
  entityCount: number;
  segmentCount: number;
  textCount: number;
  unsupportedEntityCounts: Record<string, number>;
  warnings: string[];
  layerOrder: string[];
  resolvedSourcePlane: Exclude<DxfSourcePlane, "auto">;
  sourcePlaneMode: DxfSourcePlane;
}

export interface DxfSourcePlaneResolution {
  resolvedPlane: Exclude<DxfSourcePlane, "auto">;
  warning?: string;
}

export function projectPointToSourcePlane(
  point: [number, number, number],
  plane: Exclude<DxfSourcePlane, "auto">
): [number, number] {
  switch (plane) {
    case "yz":
      return [point[1], point[2]];
    case "xz":
      return [point[0], point[2]];
    case "xy":
    default:
      return [point[0], point[1]];
  }
}

export function projectVectorToSourcePlane(
  vector: [number, number, number],
  plane: Exclude<DxfSourcePlane, "auto">
): [number, number] {
  return projectPointToSourcePlane(vector, plane);
}

export function resolveSourcePlane(
  document: ParsedDxfDocument,
  requestedPlane: DxfSourcePlane
): DxfSourcePlaneResolution {
  if (requestedPlane !== "auto") {
    return {
      resolvedPlane: requestedPlane
    };
  }

  const coordinates = {
    x: [] as number[],
    y: [] as number[],
    z: [] as number[]
  };
  const pushPoint = (point: [number, number, number]) => {
    coordinates.x.push(point[0]);
    coordinates.y.push(point[1]);
    coordinates.z.push(point[2]);
  };

  for (const entity of document.entities) {
    switch (entity.type) {
      case "LINE":
        pushPoint(entity.start);
        pushPoint(entity.end);
        break;
      case "SPLINE":
        entity.controlPoints.forEach(pushPoint);
        entity.fitPoints.forEach(pushPoint);
        break;
      case "LWPOLYLINE":
      case "POLYLINE":
        entity.vertices.forEach((vertex) => pushPoint(vertex.point));
        break;
      case "CIRCLE":
        pushPoint(entity.plane.origin);
        pushPoint(evaluatePointOnPlane(entity.plane, entity.radius, 0));
        pushPoint(evaluatePointOnPlane(entity.plane, 0, entity.radius));
        break;
      case "ARC":
        pushPoint(entity.plane.origin);
        pushPoint(evaluatePointOnPlane(entity.plane, entity.radius, 0));
        pushPoint(evaluatePointOnPlane(entity.plane, 0, entity.radius));
        break;
      case "ELLIPSE":
        pushPoint(entity.plane.origin);
        pushPoint(evaluatePointOnPlane(entity.plane, entity.majorLength, 0));
        pushPoint(evaluatePointOnPlane(entity.plane, 0, entity.minorLength));
        break;
      case "TEXT":
      case "MTEXT":
        pushPoint(entity.position);
        break;
    }
  }

  const robustSpread = (values: number[]): number => {
    if (values.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (t: number): number => {
      const position = Math.max(0, Math.min(sorted.length - 1, t * (sorted.length - 1)));
      const lowerIndex = Math.floor(position);
      const upperIndex = Math.ceil(position);
      const lower = sorted[lowerIndex] ?? 0;
      const upper = sorted[upperIndex] ?? lower;
      const alpha = position - lowerIndex;
      return lower + (upper - lower) * alpha;
    };
    return percentile(0.95) - percentile(0.05);
  };

  const spreads = {
    x: robustSpread(coordinates.x),
    y: robustSpread(coordinates.y),
    z: robustSpread(coordinates.z)
  };
  const ordered = (Object.entries(spreads) as Array<[keyof typeof spreads, number]>).sort((a, b) => a[1] - b[1]);
  const smallest = ordered[0];
  const middle = ordered[1];
  const largest = ordered[2];
  if (!smallest || !middle || !largest) {
    return {
      resolvedPlane: "xy",
      warning: "Unable to resolve source plane; defaulting to XY."
    };
  }

  const smallestSpread = Math.max(smallest[1], 1e-9);
  const clearlyPlanar = middle[1] / smallestSpread >= 20 && largest[1] / smallestSpread >= 20;
  if (!clearlyPlanar) {
    return {
      resolvedPlane: "xy",
      warning: "Source plane auto-detect was ambiguous; defaulting to XY."
    };
  }

  return {
    resolvedPlane:
      smallest[0] === "x"
        ? "yz"
        : smallest[0] === "y"
          ? "xz"
          : "xy"
  };
}

function normalizeVector3(input: [number, number, number]): [number, number, number] {
  const length = Math.hypot(input[0], input[1], input[2]);
  if (length <= 1e-9) {
    return [0, 0, 1];
  }
  return [input[0] / length, input[1] / length, input[2] / length];
}

export function makePlaneBasis(
  origin: [number, number, number],
  uAxis: [number, number, number],
  vAxis: [number, number, number]
): ParsedDxfPlaneBasis {
  const normalizedU = normalizeVector3(uAxis);
  const normalizedV = normalizeVector3(vAxis);
  const normal = normalizeVector3([
    normalizedU[1] * normalizedV[2] - normalizedU[2] * normalizedV[1],
    normalizedU[2] * normalizedV[0] - normalizedU[0] * normalizedV[2],
    normalizedU[0] * normalizedV[1] - normalizedU[1] * normalizedV[0]
  ]);
  return {
    origin,
    uAxis: normalizedU,
    vAxis: normalizedV,
    normal
  };
}

function addScaled(
  origin: [number, number, number],
  uAxis: [number, number, number],
  uAmount: number,
  vAxis: [number, number, number],
  vAmount: number
): [number, number, number] {
  return [
    origin[0] + uAxis[0] * uAmount + vAxis[0] * vAmount,
    origin[1] + uAxis[1] * uAmount + vAxis[1] * vAmount,
    origin[2] + uAxis[2] * uAmount + vAxis[2] * vAmount
  ];
}

export function evaluatePointOnPlane(
  plane: ParsedDxfPlaneBasis,
  uAmount: number,
  vAmount: number
): [number, number, number] {
  return addScaled(plane.origin, plane.uAxis, uAmount, plane.vAxis, vAmount);
}

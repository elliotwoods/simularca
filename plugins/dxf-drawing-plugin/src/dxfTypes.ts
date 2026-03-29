import type { DxfDrawingPlane, DxfInputUnits } from "./contracts";

export interface ParsedDxfLayer {
  name: string;
  sourceColor: string;
  order: number;
}

interface ParsedDxfEntityBase {
  type: string;
  layerName: string;
}

export interface ParsedDxfLineEntity extends ParsedDxfEntityBase {
  type: "LINE";
  start: [number, number];
  end: [number, number];
}

export interface ParsedDxfPolylineVertex {
  x: number;
  y: number;
  bulge?: number;
}

export interface ParsedDxfPolylineEntity extends ParsedDxfEntityBase {
  type: "LWPOLYLINE" | "POLYLINE";
  closed: boolean;
  vertices: ParsedDxfPolylineVertex[];
}

export interface ParsedDxfCircleEntity extends ParsedDxfEntityBase {
  type: "CIRCLE";
  center: [number, number];
  radius: number;
}

export interface ParsedDxfArcEntity extends ParsedDxfEntityBase {
  type: "ARC";
  center: [number, number];
  radius: number;
  startAngleDeg: number;
  endAngleDeg: number;
}

export interface ParsedDxfEllipseEntity extends ParsedDxfEntityBase {
  type: "ELLIPSE";
  center: [number, number];
  majorAxis: [number, number];
  axisRatio: number;
  startParameter: number;
  endParameter: number;
}

export interface ParsedDxfTextEntity extends ParsedDxfEntityBase {
  type: "TEXT" | "MTEXT";
  text: string;
  position: [number, number];
  height: number;
  rotationDeg: number;
}

export interface ParsedDxfInsertEntity extends ParsedDxfEntityBase {
  type: "INSERT";
  blockName: string;
  position: [number, number];
  xScale: number;
  yScale: number;
  rotationDeg: number;
  columnCount: number;
  rowCount: number;
  columnSpacing: number;
  rowSpacing: number;
}

export type ParsedDxfEntity =
  | ParsedDxfLineEntity
  | ParsedDxfPolylineEntity
  | ParsedDxfCircleEntity
  | ParsedDxfArcEntity
  | ParsedDxfEllipseEntity
  | ParsedDxfTextEntity
  | ParsedDxfInsertEntity;

export interface ParsedDxfBlock {
  name: string;
  basePoint: [number, number];
  layerName: string;
  entities: ParsedDxfEntity[];
}

export interface ParsedDxfDocument {
  layers: ParsedDxfLayer[];
  layerMap: Record<string, ParsedDxfLayer>;
  entities: ParsedDxfEntity[];
  blocks: Record<string, ParsedDxfBlock>;
  unsupportedEntityCounts: Record<string, number>;
  warnings: string[];
}

export interface DxfBuildOptions {
  inputUnits: DxfInputUnits;
  drawingPlane: DxfDrawingPlane;
  curveResolution: number;
}

export interface DxfTextRenderItem {
  text: string;
  position: [number, number, number];
  rotationRadians: number;
  heightMeters: number;
}

export interface DxfLayerGeometry {
  layerName: string;
  sourceColor: string;
  linePositions: Float32Array;
  textItems: DxfTextRenderItem[];
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
  insertCount: number;
  blockCount: number;
  unsupportedEntityCounts: Record<string, number>;
  warnings: string[];
  layerOrder: string[];
}

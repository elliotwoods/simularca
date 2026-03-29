import DxfParser, {
  type IArcEntity,
  type ICircleEntity,
  type IDxf,
  type IEllipseEntity,
  type IEntity,
  type ILayer,
  type ILineEntity,
  type ILwpolylineEntity,
  type IMtextEntity,
  type IPoint,
  type IPolylineEntity,
  type ISplineEntity,
  type ITextEntity
} from "dxf-parser";

import { normalizeHexColor, resolveAciColor, resolveTrueColor } from "@/features/dxf/dxfColor";
import {
  makePlaneBasis,
  type ParsedDxfArcEntity,
  type ParsedDxfCircleEntity,
  type ParsedDxfDocument,
  type ParsedDxfEllipseEntity,
  type ParsedDxfEntity,
  type ParsedDxfLayer,
  type ParsedDxfLineEntity,
  type ParsedDxfPolylineEntity,
  type ParsedDxfPolylineVertex,
  type ParsedDxfSplineEntity,
  type ParsedDxfTextEntity
} from "@/features/dxf/dxfTypes";

interface RawEntityMetadata {
  extrusion?: [number, number, number];
}

function getFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getPointXYZ(point: Partial<IPoint> | undefined): [number, number, number] {
  return [getFiniteNumber(point?.x, 0), getFiniteNumber(point?.y, 0), getFiniteNumber(point?.z, 0)];
}

function getLayerName(entity: Partial<IEntity>): string {
  const value = typeof entity.layer === "string" ? entity.layer.trim() : "";
  return value.length > 0 ? value : "0";
}

function decodeDxfText(raw: string): string {
  return raw
    .replace(/\\P/gi, "\n")
    .replace(/\\[AaCcFfHhLlOoQqTtWw][^;]*;/g, "")
    .replace(/\\[\\{}]/g, (match) => match.slice(1))
    .replace(/[{}]/g, "")
    .trim();
}

function resolveParserColor(color: unknown, colorIndex: unknown, fallback = "#ffffff"): string {
  if (typeof color === "number" && Number.isFinite(color) && color > 0) {
    return normalizeHexColor(resolveTrueColor(color));
  }
  if (typeof colorIndex === "number" && Number.isFinite(colorIndex)) {
    const aci = Math.abs(Math.trunc(colorIndex));
    if (aci > 0 && aci !== 256) {
      return normalizeHexColor(resolveAciColor(aci));
    }
  }
  return normalizeHexColor(fallback);
}

function buildLayers(parsed: IDxf | null): { layers: ParsedDxfLayer[]; layerByName: Map<string, ParsedDxfLayer> } {
  const layerEntries = Object.values(parsed?.tables?.layer?.layers ?? {});
  const layers: ParsedDxfLayer[] = layerEntries.map((layer, index) => ({
    name: typeof layer.name === "string" && layer.name.trim().length > 0 ? layer.name.trim() : "0",
    sourceColor: resolveParserColor(layer.color, layer.colorIndex),
    order: index
  }));
  const layerByName = new Map(layers.map((layer) => [layer.name, layer] as const));
  return { layers, layerByName };
}

function vectorLength(input: [number, number, number]): number {
  return Math.hypot(input[0], input[1], input[2]);
}

function normalizeVector(input: [number, number, number]): [number, number, number] {
  const length = vectorLength(input);
  if (length <= 1e-9) {
    return [0, 0, 1];
  }
  return [input[0] / length, input[1] / length, input[2] / length];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function add(origin: [number, number, number], delta: [number, number, number]): [number, number, number] {
  return [origin[0] + delta[0], origin[1] + delta[1], origin[2] + delta[2]];
}

function scale(vector: [number, number, number], amount: number): [number, number, number] {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function basisFromExtrusion(extrusion: [number, number, number]): { uAxis: [number, number, number]; vAxis: [number, number, number]; normal: [number, number, number] } {
  const normal = normalizeVector(extrusion);
  const reference: [number, number, number] =
    Math.abs(normal[0]) < 1 / 64 && Math.abs(normal[1]) < 1 / 64
      ? [0, 1, 0]
      : [0, 0, 1];
  const uAxis = normalizeVector(cross(reference, normal));
  const vAxis = normalizeVector(cross(normal, uAxis));
  return {
    uAxis,
    vAxis,
    normal
  };
}

function ocsPointToWcs(point: [number, number, number], extrusion: [number, number, number]): [number, number, number] {
  const basis = basisFromExtrusion(extrusion);
  return add(add(scale(basis.uAxis, point[0]), scale(basis.vAxis, point[1])), scale(basis.normal, point[2]));
}

function ocsVectorToWcs(vector: [number, number, number], extrusion: [number, number, number]): [number, number, number] {
  return ocsPointToWcs(vector, extrusion);
}

function defaultExtrusion(input?: [number, number, number]): [number, number, number] {
  const normalized = normalizeVector(input ?? [0, 0, 1]);
  return vectorLength(normalized) <= 1e-9 ? [0, 0, 1] : normalized;
}

function rawMetadataByHandle(source: string): Map<string, RawEntityMetadata> {
  const lines = source.split(/\r\n|\r|\n/g);
  const metadata = new Map<string, RawEntityMetadata>();
  let inEntities = false;
  let pendingSection = false;
  let currentHandle = "";
  let currentType = "";
  let current: RawEntityMetadata | null = null;

  const flushCurrent = () => {
    if (currentHandle && current) {
      metadata.set(currentHandle, current);
    }
    currentHandle = "";
    currentType = "";
    current = null;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index]?.trim() ?? "";
    const value = lines[index + 1]?.trim() ?? "";
    if (code === "0" && value === "SECTION") {
      pendingSection = true;
      flushCurrent();
      continue;
    }
    if (pendingSection && code === "2") {
      inEntities = value === "ENTITIES";
      pendingSection = false;
      continue;
    }
    if (code === "0" && value === "ENDSEC") {
      flushCurrent();
      inEntities = false;
      continue;
    }
    if (!inEntities) {
      continue;
    }
    if (code === "0") {
      flushCurrent();
      currentType = value;
      current = {};
      continue;
    }
    if (!current || !currentType) {
      continue;
    }
    if (code === "5") {
      currentHandle = value;
      continue;
    }
    if (code === "210" || code === "220" || code === "230") {
      const componentIndex = code === "210" ? 0 : code === "220" ? 1 : 2;
      const next = current.extrusion ?? [0, 0, 1];
      next[componentIndex] = Number.parseFloat(value);
      current.extrusion = next;
    }
  }

  flushCurrent();
  return metadata;
}

function getEntityExtrusion(
  entity: Partial<IEntity> & {
    extrusionDirection?: IPoint;
    extrusionDirectionX?: number;
    extrusionDirectionY?: number;
    extrusionDirectionZ?: number;
    normalVector?: IPoint;
  },
  metadataByHandle: Map<string, RawEntityMetadata>
): [number, number, number] {
  const rawHandle = typeof entity.handle === "string" ? entity.handle : "";
  const metadata = rawHandle ? metadataByHandle.get(rawHandle) : undefined;
  return defaultExtrusion(
    metadata?.extrusion
      ?? (entity.extrusionDirection ? getPointXYZ(entity.extrusionDirection) : undefined)
      ?? (typeof entity.extrusionDirectionX === "number" || typeof entity.extrusionDirectionY === "number" || typeof entity.extrusionDirectionZ === "number"
        ? [
            getFiniteNumber(entity.extrusionDirectionX, 0),
            getFiniteNumber(entity.extrusionDirectionY, 0),
            getFiniteNumber(entity.extrusionDirectionZ, 1)
          ]
        : undefined)
      ?? (entity.normalVector ? getPointXYZ(entity.normalVector) : undefined)
  );
}

function mapLineEntity(entity: ILineEntity): ParsedDxfLineEntity | null {
  if (!Array.isArray(entity.vertices) || entity.vertices.length < 2) {
    return null;
  }
  return {
    type: "LINE",
    layerName: getLayerName(entity),
    start: getPointXYZ(entity.vertices[0]),
    end: getPointXYZ(entity.vertices[1])
  };
}

function mapSplineEntity(entity: ISplineEntity): ParsedDxfSplineEntity | null {
  const controlPoints = Array.isArray(entity.controlPoints) ? entity.controlPoints.map((point) => getPointXYZ(point)) : [];
  const fitPoints = Array.isArray(entity.fitPoints) ? entity.fitPoints.map((point) => getPointXYZ(point)) : [];
  if (controlPoints.length === 0 && fitPoints.length === 0) {
    return null;
  }
  return {
    type: "SPLINE",
    layerName: getLayerName(entity),
    degree: Math.max(1, Math.floor(getFiniteNumber(entity.degreeOfSplineCurve, 1))),
    knotValues: Array.isArray(entity.knotValues) ? entity.knotValues.map((value) => getFiniteNumber(value, 0)) : [],
    controlPoints,
    fitPoints,
    closed: entity.closed === true,
    planar: entity.planar === true,
    linear: entity.linear === true
  };
}

function mapPolylineVertices(
  vertices: Array<Partial<IPoint> & { bulge?: number }> | undefined,
  extrusion: [number, number, number],
  elevation = 0,
  useWcsVertices = false
): ParsedDxfPolylineVertex[] {
  if (!Array.isArray(vertices)) {
    return [];
  }
  return vertices.map((vertex) => {
    const point = useWcsVertices
      ? getPointXYZ(vertex)
      : ocsPointToWcs(
          [
            getFiniteNumber(vertex.x, 0),
            getFiniteNumber(vertex.y, 0),
            getFiniteNumber(vertex.z, elevation),
          ],
          extrusion
        );
    const mapped: ParsedDxfPolylineVertex = { point };
    const bulge = getFiniteNumber(vertex.bulge, 0);
    if (Math.abs(bulge) > 1e-9) {
      mapped.bulge = bulge;
    }
    return mapped;
  });
}

function mapLwPolylineEntity(
  entity: ILwpolylineEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfPolylineEntity {
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  return {
    type: "LWPOLYLINE",
    layerName: getLayerName(entity),
    closed: Boolean(entity.shape),
    vertices: mapPolylineVertices(entity.vertices, extrusion, getFiniteNumber(entity.elevation, 0), false)
  };
}

function mapPolylineEntity(
  entity: IPolylineEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfPolylineEntity {
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  return {
    type: "POLYLINE",
    layerName: getLayerName(entity),
    closed: Boolean(entity.shape),
    vertices: mapPolylineVertices(entity.vertices, extrusion, 0, Boolean(entity.is3dPolyline))
  };
}

function mapCircleEntity(
  entity: ICircleEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfCircleEntity {
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  const basis = basisFromExtrusion(extrusion);
  const center = ocsPointToWcs(getPointXYZ(entity.center), extrusion);
  return {
    type: "CIRCLE",
    layerName: getLayerName(entity),
    plane: makePlaneBasis(center, basis.uAxis, basis.vAxis),
    radius: Math.max(0, getFiniteNumber(entity.radius, 0))
  };
}

function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

function mapArcEntity(
  entity: IArcEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfArcEntity {
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  const basis = basisFromExtrusion(extrusion);
  const center = ocsPointToWcs(getPointXYZ(entity.center), extrusion);
  return {
    type: "ARC",
    layerName: getLayerName(entity),
    plane: makePlaneBasis(center, basis.uAxis, basis.vAxis),
    radius: Math.max(0, getFiniteNumber(entity.radius, 0)),
    startAngleDeg: toDegrees(getFiniteNumber(entity.startAngle, 0)),
    endAngleDeg: toDegrees(getFiniteNumber(entity.endAngle, 0))
  };
}

function mapEllipseEntity(
  entity: IEllipseEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfEllipseEntity {
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  const center = ocsPointToWcs(getPointXYZ(entity.center), extrusion);
  const majorAxisVector = ocsVectorToWcs(getPointXYZ(entity.majorAxisEndPoint), extrusion);
  const majorLength = Math.max(vectorLength(majorAxisVector), 1e-6);
  const uAxis = normalizeVector(majorAxisVector);
  const normal = defaultExtrusion(extrusion);
  const vAxis = normalizeVector(cross(normal, uAxis));
  return {
    type: "ELLIPSE",
    layerName: getLayerName(entity),
    plane: makePlaneBasis(center, uAxis, vAxis),
    majorLength,
    minorLength: majorLength * Math.max(1e-6, getFiniteNumber(entity.axisRatio, 1)),
    startParameter: getFiniteNumber(entity.startAngle, 0),
    endParameter: getFiniteNumber(entity.endAngle, Math.PI * 2)
  };
}

function directionFromRotation(rotationDeg: number, extrusion: [number, number, number]): [number, number, number] {
  const basis = basisFromExtrusion(extrusion);
  const angle = (rotationDeg * Math.PI) / 180;
  return normalizeVector(add(scale(basis.uAxis, Math.cos(angle)), scale(basis.vAxis, Math.sin(angle))));
}

function mapTextEntity(
  entity: ITextEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfTextEntity | null {
  const text = decodeDxfText(typeof entity.text === "string" ? entity.text : "");
  if (text.length === 0) {
    return null;
  }
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  const position = ocsPointToWcs(getPointXYZ(entity.startPoint), extrusion);
  const endPoint = entity.endPoint ? ocsPointToWcs(getPointXYZ(entity.endPoint), extrusion) : null;
  const explicitRotation = getFiniteNumber(entity.rotation, Number.NaN);
  const direction =
    endPoint && vectorLength([endPoint[0] - position[0], endPoint[1] - position[1], endPoint[2] - position[2]]) > 1e-9
      ? normalizeVector([endPoint[0] - position[0], endPoint[1] - position[1], endPoint[2] - position[2]])
      : directionFromRotation(Number.isFinite(explicitRotation) ? explicitRotation : 0, extrusion);
  return {
    type: "TEXT",
    layerName: getLayerName(entity),
    text,
    position,
    direction,
    height: Math.max(0.001, getFiniteNumber(entity.textHeight, 1))
  };
}

function mapMTextEntity(
  entity: IMtextEntity,
  metadataByHandle: Map<string, RawEntityMetadata>
): ParsedDxfTextEntity | null {
  const text = decodeDxfText(typeof entity.text === "string" ? entity.text : "");
  if (text.length === 0) {
    return null;
  }
  const extrusion = getEntityExtrusion(entity, metadataByHandle);
  const position = ocsPointToWcs(getPointXYZ(entity.position), extrusion);
  const explicitRotation = getFiniteNumber(entity.rotation, Number.NaN);
  const direction =
    entity.directionVector && vectorLength(getPointXYZ(entity.directionVector)) > 1e-9
      ? normalizeVector(ocsVectorToWcs(getPointXYZ(entity.directionVector), extrusion))
      : directionFromRotation(Number.isFinite(explicitRotation) ? explicitRotation : 0, extrusion);
  return {
    type: "MTEXT",
    layerName: getLayerName(entity),
    text,
    position,
    direction,
    height: Math.max(0.001, getFiniteNumber(entity.height, 1))
  };
}

function addUnsupported(counter: Record<string, number>, type: string): void {
  counter[type] = (counter[type] ?? 0) + 1;
}

function updateExtents(
  extents: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  point: [number, number, number]
): void {
  extents.minX = Math.min(extents.minX, point[0]);
  extents.minY = Math.min(extents.minY, point[1]);
  extents.minZ = Math.min(extents.minZ, point[2]);
  extents.maxX = Math.max(extents.maxX, point[0]);
  extents.maxY = Math.max(extents.maxY, point[1]);
  extents.maxZ = Math.max(extents.maxZ, point[2]);
}

function computeExtents(entities: ParsedDxfEntity[]): ParsedDxfDocument["extents"] {
  const extents = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
  const push = (point: [number, number, number]) => updateExtents(extents, point);

  for (const entity of entities) {
    switch (entity.type) {
      case "LINE":
        push(entity.start);
        push(entity.end);
        break;
      case "SPLINE":
        entity.controlPoints.forEach(push);
        entity.fitPoints.forEach(push);
        break;
      case "LWPOLYLINE":
      case "POLYLINE":
        entity.vertices.forEach((vertex) => push(vertex.point));
        break;
      case "TEXT":
      case "MTEXT":
        push(entity.position);
        break;
      case "CIRCLE":
      case "ARC":
      case "ELLIPSE":
        push(entity.plane.origin);
        break;
    }
  }

  if (
    !Number.isFinite(extents.minX)
    || !Number.isFinite(extents.minY)
    || !Number.isFinite(extents.minZ)
    || !Number.isFinite(extents.maxX)
    || !Number.isFinite(extents.maxY)
    || !Number.isFinite(extents.maxZ)
  ) {
    return undefined;
  }
  return {
    min: [extents.minX, extents.minY, extents.minZ],
    max: [extents.maxX, extents.maxY, extents.maxZ]
  };
}

function ensureLayer(
  layerByName: Map<string, ParsedDxfLayer>,
  layers: ParsedDxfLayer[],
  layerName: string,
  nextOrder: { value: number },
  sourceColor = "#ffffff"
): void {
  if (layerByName.has(layerName)) {
    return;
  }
  const layer: ParsedDxfLayer = {
    name: layerName,
    sourceColor: normalizeHexColor(sourceColor),
    order: nextOrder.value
  };
  nextOrder.value += 1;
  layerByName.set(layerName, layer);
  layers.push(layer);
}

function addLayersFromEntities(
  parsed: IDxf | null,
  entities: ParsedDxfEntity[],
  layers: ParsedDxfLayer[],
  layerByName: Map<string, ParsedDxfLayer>,
  nextOrder: { value: number }
): void {
  const parserLayers = parsed?.tables?.layer?.layers ?? {};
  for (const entity of entities) {
    const parserLayer = parserLayers[entity.layerName] as ILayer | undefined;
    ensureLayer(
      layerByName,
      layers,
      entity.layerName,
      nextOrder,
      resolveParserColor(parserLayer?.color, parserLayer?.colorIndex)
    );
  }
}

export function parseDxf(source: string): ParsedDxfDocument {
  const parser = new DxfParser();
  const parsed = parser.parseSync(source);
  const metadataByHandle = rawMetadataByHandle(source);
  const entities: ParsedDxfEntity[] = [];
  const unsupportedEntityCounts: Record<string, number> = {};
  const warnings: string[] = [];
  const { layers, layerByName } = buildLayers(parsed);
  const nextLayerOrder = { value: layers.reduce((max, layer) => Math.max(max, layer.order + 1), 0) };

  for (const entity of parsed?.entities ?? []) {
    try {
      switch (entity.type) {
        case "LINE": {
          const mapped = mapLineEntity(entity as ILineEntity);
          if (mapped) {
            entities.push(mapped);
          }
          break;
        }
        case "SPLINE": {
          const mapped = mapSplineEntity(entity as ISplineEntity);
          if (mapped) {
            entities.push(mapped);
          }
          break;
        }
        case "LWPOLYLINE":
          entities.push(mapLwPolylineEntity(entity as ILwpolylineEntity, metadataByHandle));
          break;
        case "POLYLINE":
          entities.push(mapPolylineEntity(entity as IPolylineEntity, metadataByHandle));
          break;
        case "CIRCLE":
          entities.push(mapCircleEntity(entity as ICircleEntity, metadataByHandle));
          break;
        case "ARC":
          entities.push(mapArcEntity(entity as IArcEntity, metadataByHandle));
          break;
        case "ELLIPSE":
          entities.push(mapEllipseEntity(entity as IEllipseEntity, metadataByHandle));
          break;
        case "TEXT": {
          const mapped = mapTextEntity(entity as ITextEntity, metadataByHandle);
          if (mapped) {
            entities.push(mapped);
          }
          break;
        }
        case "MTEXT": {
          const mapped = mapMTextEntity(entity as IMtextEntity, metadataByHandle);
          if (mapped) {
            entities.push(mapped);
          }
          break;
        }
        case "INSERT":
          throw new Error("DXF INSERT/block content is not supported in v1. Explode blocks before import.");
        default:
          addUnsupported(unsupportedEntityCounts, entity.type);
          break;
      }
    } catch (error) {
      if (entity.type === "INSERT") {
        throw error;
      }
      addUnsupported(unsupportedEntityCounts, entity.type);
      warnings.push(`${entity.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  addLayersFromEntities(parsed, entities, layers, layerByName, nextLayerOrder);
  ensureLayer(layerByName, layers, "0", nextLayerOrder);
  layers.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    layers,
    entities,
    extents: computeExtents(entities),
    unsupportedEntityCounts,
    warnings
  };
}

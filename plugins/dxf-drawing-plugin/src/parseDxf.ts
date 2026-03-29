import DxfParser, {
  type IArcEntity,
  type IBlock,
  type ICircleEntity,
  type IDxf,
  type IEllipseEntity,
  type IEntity,
  type IInsertEntity,
  type ILayer,
  type ILineEntity,
  type ILwpolylineEntity,
  type IMtextEntity,
  type IPoint,
  type IPolylineEntity,
  type ITextEntity
} from "dxf-parser";

import { normalizeHexColor, resolveAciColor, resolveTrueColor } from "./dxfColor";
import type {
  ParsedDxfArcEntity,
  ParsedDxfBlock,
  ParsedDxfCircleEntity,
  ParsedDxfDocument,
  ParsedDxfEllipseEntity,
  ParsedDxfEntity,
  ParsedDxfInsertEntity,
  ParsedDxfLayer,
  ParsedDxfLineEntity,
  ParsedDxfPolylineEntity,
  ParsedDxfPolylineVertex,
  ParsedDxfTextEntity
} from "./dxfTypes";

function getFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getPointXY(point: Partial<IPoint> | undefined): [number, number] {
  return [getFiniteNumber(point?.x, 0), getFiniteNumber(point?.y, 0)];
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

function mapLineEntity(entity: ILineEntity): ParsedDxfLineEntity | null {
  if (!Array.isArray(entity.vertices) || entity.vertices.length < 2) {
    return null;
  }
  return {
    type: "LINE",
    layerName: getLayerName(entity),
    start: getPointXY(entity.vertices[0]),
    end: getPointXY(entity.vertices[1])
  };
}

function mapPolylineVertices(vertices: Array<Partial<IPoint> & { bulge?: number }> | undefined): ParsedDxfPolylineVertex[] {
  if (!Array.isArray(vertices)) {
    return [];
  }
  return vertices.map((vertex) => {
    const mapped: ParsedDxfPolylineVertex = {
      x: getFiniteNumber(vertex.x, 0),
      y: getFiniteNumber(vertex.y, 0)
    };
    const bulge = getFiniteNumber(vertex.bulge, 0);
    if (Math.abs(bulge) > 1e-9) {
      mapped.bulge = bulge;
    }
    return mapped;
  });
}

function mapLwPolylineEntity(entity: ILwpolylineEntity): ParsedDxfPolylineEntity {
  return {
    type: "LWPOLYLINE",
    layerName: getLayerName(entity),
    closed: Boolean(entity.shape),
    vertices: mapPolylineVertices(entity.vertices)
  };
}

function mapPolylineEntity(entity: IPolylineEntity): ParsedDxfPolylineEntity {
  return {
    type: "POLYLINE",
    layerName: getLayerName(entity),
    closed: Boolean(entity.shape),
    vertices: mapPolylineVertices(entity.vertices)
  };
}

function mapCircleEntity(entity: ICircleEntity): ParsedDxfCircleEntity {
  return {
    type: "CIRCLE",
    layerName: getLayerName(entity),
    center: getPointXY(entity.center),
    radius: Math.max(0, getFiniteNumber(entity.radius, 0))
  };
}

function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

function mapArcEntity(entity: IArcEntity): ParsedDxfArcEntity {
  return {
    type: "ARC",
    layerName: getLayerName(entity),
    center: getPointXY(entity.center),
    radius: Math.max(0, getFiniteNumber(entity.radius, 0)),
    startAngleDeg: toDegrees(getFiniteNumber(entity.startAngle, 0)),
    endAngleDeg: toDegrees(getFiniteNumber(entity.endAngle, 0))
  };
}

function mapEllipseEntity(entity: IEllipseEntity): ParsedDxfEllipseEntity {
  return {
    type: "ELLIPSE",
    layerName: getLayerName(entity),
    center: getPointXY(entity.center),
    majorAxis: getPointXY(entity.majorAxisEndPoint),
    axisRatio: Math.max(1e-6, getFiniteNumber(entity.axisRatio, 1)),
    startParameter: getFiniteNumber(entity.startAngle, 0),
    endParameter: getFiniteNumber(entity.endAngle, Math.PI * 2)
  };
}

function mapTextEntity(entity: ITextEntity): ParsedDxfTextEntity | null {
  const text = decodeDxfText(typeof entity.text === "string" ? entity.text : "");
  if (text.length === 0) {
    return null;
  }
  const [startX, startY] = getPointXY(entity.startPoint);
  const endPoint = entity.endPoint;
  const dx = getFiniteNumber(endPoint?.x, startX + 1) - startX;
  const dy = getFiniteNumber(endPoint?.y, startY) - startY;
  const explicitRotation = getFiniteNumber(entity.rotation, Number.NaN);
  const rotationDeg =
    Number.isFinite(explicitRotation)
      ? explicitRotation
      : Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9
        ? toDegrees(Math.atan2(dy, dx))
        : 0;
  return {
    type: "TEXT",
    layerName: getLayerName(entity),
    text,
    position: [startX, startY],
    height: Math.max(0.001, getFiniteNumber(entity.textHeight, 1)),
    rotationDeg
  };
}

function mapMTextEntity(entity: IMtextEntity): ParsedDxfTextEntity | null {
  const text = decodeDxfText(typeof entity.text === "string" ? entity.text : "");
  if (text.length === 0) {
    return null;
  }
  const [x, y] = getPointXY(entity.position);
  const direction = entity.directionVector;
  const dx = getFiniteNumber(direction?.x, 1);
  const dy = getFiniteNumber(direction?.y, 0);
  const explicitRotation = getFiniteNumber(entity.rotation, Number.NaN);
  const rotationDeg =
    Number.isFinite(explicitRotation)
      ? explicitRotation
      : Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9
        ? toDegrees(Math.atan2(dy, dx))
        : 0;
  return {
    type: "MTEXT",
    layerName: getLayerName(entity),
    text,
    position: [x, y],
    height: Math.max(0.001, getFiniteNumber(entity.height, 1)),
    rotationDeg
  };
}

function mapInsertEntity(entity: IInsertEntity): ParsedDxfInsertEntity | null {
  const blockName = typeof entity.name === "string" ? entity.name.trim() : "";
  if (!blockName) {
    return null;
  }
  return {
    type: "INSERT",
    layerName: getLayerName(entity),
    blockName,
    position: getPointXY(entity.position),
    xScale: getFiniteNumber(entity.xScale, 1),
    yScale: getFiniteNumber(entity.yScale, 1),
    rotationDeg: getFiniteNumber(entity.rotation, 0),
    columnCount: Math.max(1, Math.floor(getFiniteNumber(entity.columnCount, 1))),
    rowCount: Math.max(1, Math.floor(getFiniteNumber(entity.rowCount, 1))),
    columnSpacing: getFiniteNumber(entity.columnSpacing, 0),
    rowSpacing: getFiniteNumber(entity.rowSpacing, 0)
  };
}

function addUnsupported(counter: Record<string, number>, type: string): void {
  counter[type] = (counter[type] ?? 0) + 1;
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

function ensureLayersForEntities(
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

function mapEntity(entity: IEntity): ParsedDxfEntity | null {
  switch (entity.type) {
    case "LINE":
      return mapLineEntity(entity as ILineEntity);
    case "LWPOLYLINE":
      return mapLwPolylineEntity(entity as ILwpolylineEntity);
    case "POLYLINE":
      return mapPolylineEntity(entity as IPolylineEntity);
    case "CIRCLE":
      return mapCircleEntity(entity as ICircleEntity);
    case "ARC":
      return mapArcEntity(entity as IArcEntity);
    case "ELLIPSE":
      return mapEllipseEntity(entity as IEllipseEntity);
    case "TEXT":
      return mapTextEntity(entity as ITextEntity);
    case "MTEXT":
      return mapMTextEntity(entity as IMtextEntity);
    case "INSERT":
      return mapInsertEntity(entity as IInsertEntity);
    default:
      return null;
  }
}

function mapEntities(
  entities: IEntity[],
  unsupportedEntityCounts: Record<string, number>,
  warnings: string[],
  contextLabel: string
): ParsedDxfEntity[] {
  const result: ParsedDxfEntity[] = [];
  for (const entity of entities) {
    try {
      const mapped = mapEntity(entity);
      if (mapped) {
        result.push(mapped);
        continue;
      }
      addUnsupported(unsupportedEntityCounts, entity.type);
    } catch (error) {
      addUnsupported(unsupportedEntityCounts, entity.type);
      warnings.push(`${contextLabel}${entity.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function mapBlocks(
  parsed: IDxf | null,
  layers: ParsedDxfLayer[],
  layerByName: Map<string, ParsedDxfLayer>,
  nextOrder: { value: number },
  unsupportedEntityCounts: Record<string, number>,
  warnings: string[]
): Record<string, ParsedDxfBlock> {
  const blocks: Record<string, ParsedDxfBlock> = {};
  for (const rawBlock of Object.values(parsed?.blocks ?? {})) {
    const block = rawBlock as IBlock;
    const name = typeof block.name === "string" ? block.name.trim() : "";
    if (!name) {
      continue;
    }
    const entities = mapEntities(block.entities ?? [], unsupportedEntityCounts, warnings, `BLOCK ${name} `);
    ensureLayersForEntities(parsed, entities, layers, layerByName, nextOrder);
    blocks[name] = {
      name,
      basePoint: getPointXY(block.position),
      layerName: typeof block.layer === "string" && block.layer.trim() ? block.layer.trim() : "0",
      entities
    };
  }
  return blocks;
}

export function parseDxf(source: string): ParsedDxfDocument {
  const parser = new DxfParser();
  const parsed = parser.parseSync(source);
  const unsupportedEntityCounts: Record<string, number> = {};
  const warnings: string[] = [];
  const { layers, layerByName } = buildLayers(parsed);
  const nextLayerOrder = { value: layers.reduce((max, layer) => Math.max(max, layer.order + 1), 0) };
  const entities = mapEntities(parsed?.entities ?? [], unsupportedEntityCounts, warnings, "");
  ensureLayersForEntities(parsed, entities, layers, layerByName, nextLayerOrder);
  const blocks = mapBlocks(parsed, layers, layerByName, nextLayerOrder, unsupportedEntityCounts, warnings);
  ensureLayer(layerByName, layers, "0", nextLayerOrder);
  layers.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    layers,
    layerMap: Object.fromEntries(layers.map((layer) => [layer.name, layer] as const)),
    entities,
    blocks,
    unsupportedEntityCounts,
    warnings
  };
}

import * as THREE from "three";
import type { DxfDrawingPlane, DxfLayerStateMap, DxfSourcePlane, DxfInputUnits } from "@/core/types";
import { invertHexColor, normalizeHexColor } from "@/features/dxf/dxfColor";
import {
  projectPointToSourcePlane,
  projectVectorToSourcePlane,
  resolveSourcePlane,
  type BuiltDxfScene,
  type DxfBuildOptions,
  type DxfLayerGeometry,
  type DxfTextRenderItem,
  type ParsedDxfArcEntity,
  type ParsedDxfCircleEntity,
  type ParsedDxfDocument,
  type ParsedDxfEllipseEntity,
  type ParsedDxfPlaneBasis,
  type ParsedDxfPolylineEntity,
  type ParsedDxfSplineEntity
} from "@/features/dxf/dxfTypes";

const LAYER_GROUP_PREFIX = "dxf-layer:";

function unitScale(units: DxfInputUnits): number {
  switch (units) {
    case "centimeters":
      return 0.01;
    case "meters":
      return 1;
    case "inches":
      return 0.0254;
    case "feet":
      return 0.3048;
    case "millimeters":
    default:
      return 0.001;
  }
}

function mapPoint(x: number, y: number, plane: DxfDrawingPlane, scale: number): [number, number, number] {
  const scaledX = x * scale;
  const scaledY = y * scale;
  switch (plane) {
    case "front-xy":
      return [scaledX, scaledY, 0];
    case "side-zy":
      return [0, scaledY, -scaledX];
    case "plan-xz":
    default:
      return [scaledX, 0, -scaledY];
  }
}

function planeQuaternion(plane: DxfDrawingPlane): THREE.Quaternion {
  switch (plane) {
    case "plan-xz":
      return new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ"));
    case "side-zy":
      return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0, "XYZ"));
    case "front-xy":
    default:
      return new THREE.Quaternion();
  }
}

function pushSegment(target: number[], a: [number, number], b: [number, number], plane: DxfDrawingPlane, scale: number): void {
  const mappedA = mapPoint(a[0], a[1], plane, scale);
  const mappedB = mapPoint(b[0], b[1], plane, scale);
  target.push(mappedA[0], mappedA[1], mappedA[2], mappedB[0], mappedB[1], mappedB[2]);
}

function normalizeArcSweep(start: number, end: number): number {
  let sweep = end - start;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
}

function projectPoint(point: [number, number, number], sourcePlane: Exclude<DxfSourcePlane, "auto">): [number, number] {
  return projectPointToSourcePlane(point, sourcePlane);
}

function projectVector(vector: [number, number, number], sourcePlane: Exclude<DxfSourcePlane, "auto">): [number, number] {
  return projectVectorToSourcePlane(vector, sourcePlane);
}

function planeBasis2d(plane: ParsedDxfPlaneBasis, sourcePlane: Exclude<DxfSourcePlane, "auto">): { origin: [number, number]; uAxis: [number, number]; vAxis: [number, number] } {
  return {
    origin: projectPoint(plane.origin, sourcePlane),
    uAxis: projectVector(plane.uAxis, sourcePlane),
    vAxis: projectVector(plane.vAxis, sourcePlane)
  };
}

function appendCircleSegments(
  entity: ParsedDxfCircleEntity,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  const plane2d = planeBasis2d(entity.plane, sourcePlane);
  const steps = Math.max(12, resolution);
  let segments = 0;
  for (let index = 0; index < steps; index += 1) {
    const a0 = (index / steps) * Math.PI * 2;
    const a1 = ((index + 1) / steps) * Math.PI * 2;
    const p0: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(a0) * entity.radius + plane2d.vAxis[0] * Math.sin(a0) * entity.radius,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(a0) * entity.radius + plane2d.vAxis[1] * Math.sin(a0) * entity.radius
    ];
    const p1: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(a1) * entity.radius + plane2d.vAxis[0] * Math.sin(a1) * entity.radius,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(a1) * entity.radius + plane2d.vAxis[1] * Math.sin(a1) * entity.radius
    ];
    pushSegment(target, p0, p1, targetPlane, scale);
    segments += 1;
  }
  return segments;
}

function appendArcSegments(
  entity: ParsedDxfArcEntity,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  const plane2d = planeBasis2d(entity.plane, sourcePlane);
  const start = THREE.MathUtils.degToRad(entity.startAngleDeg);
  const end = THREE.MathUtils.degToRad(entity.endAngleDeg);
  const sweep = normalizeArcSweep(start, end);
  const steps = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * resolution));
  let segments = 0;
  for (let index = 0; index < steps; index += 1) {
    const a0 = start + (index / steps) * sweep;
    const a1 = start + ((index + 1) / steps) * sweep;
    const p0: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(a0) * entity.radius + plane2d.vAxis[0] * Math.sin(a0) * entity.radius,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(a0) * entity.radius + plane2d.vAxis[1] * Math.sin(a0) * entity.radius
    ];
    const p1: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(a1) * entity.radius + plane2d.vAxis[0] * Math.sin(a1) * entity.radius,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(a1) * entity.radius + plane2d.vAxis[1] * Math.sin(a1) * entity.radius
    ];
    pushSegment(target, p0, p1, targetPlane, scale);
    segments += 1;
  }
  return segments;
}

function appendEllipseSegments(
  entity: ParsedDxfEllipseEntity,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  const plane2d = planeBasis2d(entity.plane, sourcePlane);
  const start = entity.startParameter;
  const end = entity.endParameter;
  const sweep = normalizeArcSweep(start, end);
  const steps = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * resolution));
  let segments = 0;
  for (let index = 0; index < steps; index += 1) {
    const t0 = start + (index / steps) * sweep;
    const t1 = start + ((index + 1) / steps) * sweep;
    const p0: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(t0) * entity.majorLength + plane2d.vAxis[0] * Math.sin(t0) * entity.minorLength,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(t0) * entity.majorLength + plane2d.vAxis[1] * Math.sin(t0) * entity.minorLength
    ];
    const p1: [number, number] = [
      plane2d.origin[0] + plane2d.uAxis[0] * Math.cos(t1) * entity.majorLength + plane2d.vAxis[0] * Math.sin(t1) * entity.minorLength,
      plane2d.origin[1] + plane2d.uAxis[1] * Math.cos(t1) * entity.majorLength + plane2d.vAxis[1] * Math.sin(t1) * entity.minorLength
    ];
    pushSegment(target, p0, p1, targetPlane, scale);
    segments += 1;
  }
  return segments;
}

function appendBulgeSegments(
  start: { point: [number, number, number]; bulge?: number },
  end: { point: [number, number, number]; bulge?: number },
  bulge: number,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  const start2 = projectPoint(start.point, sourcePlane);
  const end2 = projectPoint(end.point, sourcePlane);
  const chordDx = end2[0] - start2[0];
  const chordDy = end2[1] - start2[1];
  const chord = Math.hypot(chordDx, chordDy);
  if (chord < 1e-9 || Math.abs(bulge) < 1e-9) {
    pushSegment(target, start2, end2, targetPlane, scale);
    return 1;
  }
  const sweep = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  if (!Number.isFinite(radius) || radius < 1e-9) {
    pushSegment(target, start2, end2, targetPlane, scale);
    return 1;
  }
  const midX = (start2[0] + end2[0]) * 0.5;
  const midY = (start2[1] + end2[1]) * 0.5;
  const offset = Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4));
  const nx = -chordDy / chord;
  const ny = chordDx / chord;
  const direction = bulge >= 0 ? 1 : -1;
  const centerX = midX + nx * offset * direction;
  const centerY = midY + ny * offset * direction;
  const startAngle = Math.atan2(start2[1] - centerY, start2[0] - centerX);
  const steps = Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * resolution));
  let segments = 0;
  for (let index = 0; index < steps; index += 1) {
    const a0 = startAngle + (index / steps) * sweep;
    const a1 = startAngle + ((index + 1) / steps) * sweep;
    pushSegment(
      target,
      [centerX + Math.cos(a0) * radius, centerY + Math.sin(a0) * radius],
      [centerX + Math.cos(a1) * radius, centerY + Math.sin(a1) * radius],
      targetPlane,
      scale
    );
    segments += 1;
  }
  return segments;
}

function appendPolylineSegments(
  entity: ParsedDxfPolylineEntity,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  if (entity.vertices.length < 2) {
    return 0;
  }
  let segments = 0;
  const segmentCount = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const current = entity.vertices[index];
    const next = entity.vertices[(index + 1) % entity.vertices.length];
    if (!current || !next) {
      continue;
    }
    if (current.bulge && Math.abs(current.bulge) > 1e-9) {
      segments += appendBulgeSegments(current, next, current.bulge, sourcePlane, targetPlane, scale, resolution, target);
      continue;
    }
    pushSegment(target, projectPoint(current.point, sourcePlane), projectPoint(next.point, sourcePlane), targetPlane, scale);
    segments += 1;
  }
  return segments;
}

function evaluateBSplinePoint(points: Array<[number, number]>, knots: number[], degree: number, parameter: number): [number, number] {
  const lastKnot = knots[knots.length - 1] ?? parameter;
  const safeParameter = parameter === lastKnot ? parameter - 1e-9 : parameter;
  let span = degree;
  for (let index = degree; index < knots.length - degree - 1; index += 1) {
    const knotStart = knots[index];
    const knotEnd = knots[index + 1];
    if (knotStart === undefined || knotEnd === undefined) {
      continue;
    }
    if (safeParameter >= knotStart && safeParameter < knotEnd) {
      span = index;
      break;
    }
  }
  const values = points.slice(span - degree, span + 1).map(([x, y]) => ({ x, y }));
  for (let level = 1; level <= degree; level += 1) {
    for (let index = degree; index >= level; index -= 1) {
      const knotIndex = span - degree + index;
      const knotStart = knots[knotIndex];
      const knotEnd = knots[knotIndex + degree - level + 1];
      if (knotStart === undefined || knotEnd === undefined) {
        continue;
      }
      const denominator = knotEnd - knotStart;
      const alpha = Math.abs(denominator) <= 1e-9 ? 0 : (safeParameter - knotStart) / denominator;
      const prev = values[index - 1];
      const current = values[index];
      if (!prev || !current) {
        continue;
      }
      values[index] = {
        x: (1 - alpha) * prev.x + alpha * current.x,
        y: (1 - alpha) * prev.y + alpha * current.y
      };
    }
  }
  const result = values[degree];
  if (!result) {
    const fallback = points[Math.max(0, Math.min(points.length - 1, span))] ?? [0, 0];
    return fallback;
  }
  return [result.x, result.y];
}

function appendSplineSegments(
  entity: ParsedDxfSplineEntity,
  sourcePlane: Exclude<DxfSourcePlane, "auto">,
  targetPlane: DxfDrawingPlane,
  scale: number,
  resolution: number,
  target: number[]
): number {
  const projectedPoints = (entity.controlPoints.length > 0 ? entity.controlPoints : entity.fitPoints).map((point) => projectPoint(point, sourcePlane));
  if (projectedPoints.length < 2) {
    return 0;
  }
  if (entity.degree <= 1 || entity.linear || projectedPoints.length === 2) {
    let segments = 0;
    for (let index = 0; index < projectedPoints.length - 1; index += 1) {
      pushSegment(target, projectedPoints[index]!, projectedPoints[index + 1]!, targetPlane, scale);
      segments += 1;
    }
    if (entity.closed && projectedPoints.length > 2) {
      pushSegment(target, projectedPoints[projectedPoints.length - 1]!, projectedPoints[0]!, targetPlane, scale);
      segments += 1;
    }
    return segments;
  }

  if (!entity.planar || entity.degree !== 2 || entity.knotValues.length < projectedPoints.length + entity.degree + 1) {
    return 0;
  }

  const knots = entity.knotValues;
  const samplePerSpan = Math.max(2, Math.ceil(resolution / 8));
  let segments = 0;
  let previousPoint: [number, number] | null = null;
  const n = projectedPoints.length - 1;
  for (let span = entity.degree; span <= n; span += 1) {
    const start = knots[span];
    const end = knots[span + 1];
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end - start <= 1e-9) {
      continue;
    }
    for (let sampleIndex = 0; sampleIndex <= samplePerSpan; sampleIndex += 1) {
      if (span > entity.degree && sampleIndex === 0) {
        continue;
      }
      const t = start + ((end - start) * sampleIndex) / samplePerSpan;
      const nextPoint = evaluateBSplinePoint(projectedPoints, knots, entity.degree, t);
      if (previousPoint) {
        pushSegment(target, previousPoint, nextPoint, targetPlane, scale);
        segments += 1;
      }
      previousPoint = nextPoint;
    }
  }
  return segments;
}

function addBoundsPoint(bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null, point: [number, number, number]) {
  if (!bounds) {
    return {
      min: new THREE.Vector3(point[0], point[1], point[2]),
      max: new THREE.Vector3(point[0], point[1], point[2])
    };
  }
  bounds.min.min(new THREE.Vector3(point[0], point[1], point[2]));
  bounds.max.max(new THREE.Vector3(point[0], point[1], point[2]));
  return bounds;
}

export function buildDxfScene(document: ParsedDxfDocument, options: DxfBuildOptions): BuiltDxfScene {
  const scale = unitScale(options.inputUnits);
  const sourceResolution = resolveSourcePlane(document, options.sourcePlane);
  const sourcePlane = sourceResolution.resolvedPlane;
  const warnings = sourceResolution.warning ? [...document.warnings, sourceResolution.warning] : [...document.warnings];
  const layerBuckets = new Map<string, { sourceColor: string; linePositions: number[]; textItems: DxfTextRenderItem[] }>();
  for (const layer of document.layers) {
    layerBuckets.set(layer.name, {
      sourceColor: layer.sourceColor,
      linePositions: [],
      textItems: []
    });
  }

  let bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  let segmentCount = 0;
  let textCount = 0;

  for (const entity of document.entities) {
    const bucket = layerBuckets.get(entity.layerName) ?? {
      sourceColor: "#ffffff",
      linePositions: [],
      textItems: []
    };
    layerBuckets.set(entity.layerName, bucket);
    let segmentDelta = 0;
    switch (entity.type) {
      case "LINE":
        pushSegment(
          bucket.linePositions,
          projectPoint(entity.start, sourcePlane),
          projectPoint(entity.end, sourcePlane),
          options.drawingPlane,
          scale
        );
        segmentDelta = 1;
        break;
      case "SPLINE":
        segmentDelta = appendSplineSegments(entity, sourcePlane, options.drawingPlane, scale, options.curveResolution, bucket.linePositions);
        break;
      case "LWPOLYLINE":
      case "POLYLINE":
        segmentDelta = appendPolylineSegments(entity, sourcePlane, options.drawingPlane, scale, options.curveResolution, bucket.linePositions);
        break;
      case "CIRCLE":
        segmentDelta = appendCircleSegments(entity, sourcePlane, options.drawingPlane, scale, options.curveResolution, bucket.linePositions);
        break;
      case "ARC":
        segmentDelta = appendArcSegments(entity, sourcePlane, options.drawingPlane, scale, options.curveResolution, bucket.linePositions);
        break;
      case "ELLIPSE":
        segmentDelta = appendEllipseSegments(entity, sourcePlane, options.drawingPlane, scale, options.curveResolution, bucket.linePositions);
        break;
      case "TEXT":
      case "MTEXT": {
        const direction2 = projectVector(entity.direction, sourcePlane);
        bucket.textItems.push({
          text: entity.text,
          position: mapPoint(...projectPoint(entity.position, sourcePlane), options.drawingPlane, scale),
          rotationRadians: Math.atan2(direction2[1], direction2[0]),
          heightMeters: entity.height * scale
        });
        textCount += 1;
        break;
      }
    }
    segmentCount += segmentDelta;
  }

  const layers: DxfLayerGeometry[] = [];
  for (const layer of document.layers) {
    const bucket = layerBuckets.get(layer.name);
    if (!bucket) {
      continue;
    }
    const linePositions = Float32Array.from(bucket.linePositions);
    for (let index = 0; index + 2 < linePositions.length; index += 3) {
      bounds = addBoundsPoint(bounds, [linePositions[index] ?? 0, linePositions[index + 1] ?? 0, linePositions[index + 2] ?? 0]);
    }
    for (const item of bucket.textItems) {
      bounds = addBoundsPoint(bounds, item.position);
    }
    layers.push({
      layerName: layer.name,
      sourceColor: layer.sourceColor,
      linePositions,
      textItems: bucket.textItems
    });
  }

  return {
    layers,
    bounds: bounds
      ? {
          min: [bounds.min.x, bounds.min.y, bounds.min.z],
          max: [bounds.max.x, bounds.max.y, bounds.max.z]
        }
      : null,
    entityCount: document.entities.length,
    segmentCount,
    textCount,
    unsupportedEntityCounts: { ...document.unsupportedEntityCounts },
    warnings,
    layerOrder: layers.map((layer) => layer.layerName),
    resolvedSourcePlane: sourcePlane,
    sourcePlaneMode: options.sourcePlane
  };
}

function effectiveLayerColor(layerName: string, sourceColor: string, layerStates: DxfLayerStateMap, invertColors: boolean): string {
  const override = layerStates[layerName];
  const base = normalizeHexColor(override?.color ?? sourceColor);
  return invertColors ? invertHexColor(base) : base;
}

function createTextMesh(
  item: DxfTextRenderItem,
  plane: DxfDrawingPlane,
  color: string
): THREE.Mesh | null {
  const text = item.text.trim();
  if (!text) {
    return null;
  }
  const fontSize = 128;
  const padding = 24;
  const lines = text.split(/\r?\n/);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.font = `${fontSize}px sans-serif`;
  const maxWidth = Math.max(1, ...lines.map((line) => context.measureText(line).width));
  const lineHeight = fontSize * 1.15;
  canvas.width = Math.ceil(maxWidth + padding * 2);
  canvas.height = Math.ceil(lines.length * lineHeight + padding * 2);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `${fontSize}px sans-serif`;
  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "top";
  lines.forEach((line, index) => {
    context.fillText(line, padding, padding + index * lineHeight);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;

  const height = Math.max(item.heightMeters, 0.001) * Math.max(1, lines.length);
  const width = height * (canvas.width / Math.max(1, canvas.height));
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(width * 0.5, height * 0.5, 0);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    color: new THREE.Color(color),
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...item.position);
  const planeQuat = planeQuaternion(plane);
  const rotationQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), item.rotationRadians);
  mesh.quaternion.copy(planeQuat).multiply(rotationQuat);
  mesh.renderOrder = 1;
  mesh.userData.kind = "dxf-text";
  return mesh;
}

export function createDxfObject(
  built: BuiltDxfScene,
  layerStates: DxfLayerStateMap,
  appearance: { invertColors: boolean; showText: boolean; drawingPlane: DxfDrawingPlane }
): THREE.Group {
  const root = new THREE.Group();
  root.name = "dxf-reference-root";
  for (const layer of built.layers) {
    const layerGroup = new THREE.Group();
    layerGroup.name = `${LAYER_GROUP_PREFIX}${layer.layerName}`;
    layerGroup.userData.layerName = layer.layerName;
    layerGroup.userData.sourceColor = layer.sourceColor;

    const lineMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(effectiveLayerColor(layer.layerName, layer.sourceColor, layerStates, appearance.invertColors)),
      transparent: true,
      opacity: 1,
      depthWrite: false
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(layer.linePositions, 3));
    const lineSegments = new THREE.LineSegments(geometry, lineMaterial);
    lineSegments.userData.kind = "dxf-lines";
    layerGroup.add(lineSegments);

    const textGroup = new THREE.Group();
    textGroup.name = "dxf-text-group";
    textGroup.userData.kind = "dxf-text-group";
    for (const item of layer.textItems) {
      const mesh = createTextMesh(
        item,
        appearance.drawingPlane,
        effectiveLayerColor(layer.layerName, layer.sourceColor, layerStates, appearance.invertColors)
      );
      if (mesh) {
        textGroup.add(mesh);
      }
    }
    layerGroup.add(textGroup);
    root.add(layerGroup);
  }
  syncDxfAppearance(root, layerStates, appearance);
  return root;
}

export function syncDxfAppearance(
  root: THREE.Group,
  layerStates: DxfLayerStateMap,
  appearance: { invertColors: boolean; showText: boolean }
): number {
  let visibleLayerCount = 0;
  for (const child of root.children) {
    if (!(child instanceof THREE.Group)) {
      continue;
    }
    const layerName = typeof child.userData.layerName === "string" ? child.userData.layerName : "";
    const sourceColor = typeof child.userData.sourceColor === "string" ? child.userData.sourceColor : "#ffffff";
    const override = layerStates[layerName];
    const layerVisible = override?.visible !== false;
    const color = effectiveLayerColor(layerName, sourceColor, layerStates, appearance.invertColors);
    if (layerVisible) {
      visibleLayerCount += 1;
    }
    child.visible = layerVisible;
    child.traverse((node) => {
      if (node instanceof THREE.LineSegments) {
        const material = node.material;
        if (material instanceof THREE.LineBasicMaterial) {
          material.color.set(color);
        }
      }
      if (node instanceof THREE.Mesh && node.userData.kind === "dxf-text") {
        const material = node.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.color.set(color);
        }
        node.visible = layerVisible && appearance.showText;
      }
    });
    const textGroup = child.getObjectByName("dxf-text-group");
    if (textGroup instanceof THREE.Group) {
      textGroup.visible = layerVisible && appearance.showText;
    }
  }
  return visibleLayerCount;
}

export function disposeDxfObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    const geometry = (node as { geometry?: THREE.BufferGeometry }).geometry;
    if (geometry) {
      geometry.dispose();
    }
    const material = (node as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose());
    } else if (material) {
      material.dispose();
    }
    const texture = ((node as { material?: { map?: THREE.Texture } }).material as { map?: THREE.Texture } | undefined)?.map;
    if (texture) {
      texture.dispose();
    }
  });
}

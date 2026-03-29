import * as THREE from "three";
import type { DxfDrawingPlane, DxfInputUnits, DxfLayerStateMap, TextMeshFactoryArgs } from "./contracts";
import { invertHexColor, normalizeHexColor } from "./dxfColor";
import type {
  BuiltDxfScene,
  DxfBuildOptions,
  DxfLayerGeometry,
  DxfTextRenderItem,
  ParsedDxfDocument,
  ParsedDxfEntity,
  ParsedDxfInsertEntity,
  ParsedDxfPolylineEntity
} from "./dxfTypes";

const LAYER_GROUP_PREFIX = "dxf-layer:";
const MAX_INSERT_RECURSION_DEPTH = 32;

interface Transform2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

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

function mapPoint(x: number, y: number, plane: DxfDrawingPlane): [number, number, number] {
  switch (plane) {
    case "front-xy":
      return [x, y, 0];
    case "side-zy":
      return [0, y, -x];
    case "plan-xz":
    default:
      return [x, 0, -y];
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

function pushSegment(target: number[], a: [number, number, number], b: [number, number, number]): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function identityTransform(scale: number): Transform2D {
  return { a: scale, b: 0, c: 0, d: scale, tx: 0, ty: 0 };
}

function translateTransform(x: number, y: number): Transform2D {
  return { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y };
}

function rotateTransform(radians: number): Transform2D {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { a: c, b: s, c: -s, d: c, tx: 0, ty: 0 };
}

function scaleTransform(x: number, y: number): Transform2D {
  return { a: x, b: 0, c: 0, d: y, tx: 0, ty: 0 };
}

function multiplyTransform(left: Transform2D, right: Transform2D): Transform2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    tx: left.a * right.tx + left.c * right.ty + left.tx,
    ty: left.b * right.tx + left.d * right.ty + left.ty
  };
}

function applyTransform(transform: Transform2D, x: number, y: number): [number, number] {
  return [
    transform.a * x + transform.c * y + transform.tx,
    transform.b * x + transform.d * y + transform.ty
  ];
}

function applyVector(transform: Transform2D, x: number, y: number): [number, number] {
  return [
    transform.a * x + transform.c * y,
    transform.b * x + transform.d * y
  ];
}

function normalizeArcSweep(start: number, end: number): number {
  let sweep = end - start;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
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

function effectiveLayerColor(layerName: string, sourceColor: string, layerStates: DxfLayerStateMap, invertColors: boolean): string {
  const override = layerStates[layerName];
  const base = normalizeHexColor(override?.color ?? sourceColor);
  return invertColors ? invertHexColor(base) : base;
}

function resolveEntityLayer(rawLayerName: string, inheritedLayerName?: string): string {
  if (rawLayerName === "0" && inheritedLayerName) {
    return inheritedLayerName;
  }
  return rawLayerName || inheritedLayerName || "0";
}

function createInsertTransform(insert: ParsedDxfInsertEntity, basePoint: [number, number], offset: [number, number]): Transform2D {
  return multiplyTransform(
    translateTransform(insert.position[0], insert.position[1]),
    multiplyTransform(
      rotateTransform(THREE.MathUtils.degToRad(insert.rotationDeg)),
      multiplyTransform(
        scaleTransform(insert.xScale, insert.yScale),
        translateTransform(offset[0] - basePoint[0], offset[1] - basePoint[1])
      )
    )
  );
}

function appendPolylineSegments(
  entity: ParsedDxfPolylineEntity,
  transform: Transform2D,
  plane: DxfDrawingPlane,
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
      const sweep = 4 * Math.atan(current.bulge);
      const chordDx = next.x - current.x;
      const chordDy = next.y - current.y;
      const chord = Math.hypot(chordDx, chordDy);
      if (chord < 1e-9) {
        continue;
      }
      const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
      const midX = (current.x + next.x) * 0.5;
      const midY = (current.y + next.y) * 0.5;
      const offset = Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4));
      const nx = -chordDy / chord;
      const ny = chordDx / chord;
      const direction = current.bulge >= 0 ? 1 : -1;
      const centerX = midX + nx * offset * direction;
      const centerY = midY + ny * offset * direction;
      const startAngle = Math.atan2(current.y - centerY, current.x - centerX);
      const steps = Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * resolution));
      let previous = applyTransform(transform, current.x, current.y);
      for (let arcIndex = 1; arcIndex <= steps; arcIndex += 1) {
        const angle = startAngle + (arcIndex / steps) * sweep;
        const point = applyTransform(transform, centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
        pushSegment(target, mapPoint(previous[0], previous[1], plane), mapPoint(point[0], point[1], plane));
        previous = point;
        segments += 1;
      }
      continue;
    }
    const a = applyTransform(transform, current.x, current.y);
    const b = applyTransform(transform, next.x, next.y);
    pushSegment(target, mapPoint(a[0], a[1], plane), mapPoint(b[0], b[1], plane));
    segments += 1;
  }
  return segments;
}

export function buildDxfScene(document: ParsedDxfDocument, options: DxfBuildOptions): BuiltDxfScene {
  const transform = identityTransform(unitScale(options.inputUnits));
  const layerBuckets = new Map<string, { sourceColor: string; linePositions: number[]; textItems: DxfTextRenderItem[] }>();
  for (const layer of document.layers) {
    layerBuckets.set(layer.name, {
      sourceColor: layer.sourceColor,
      linePositions: [],
      textItems: []
    });
  }

  const warnings = [...document.warnings];
  let bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  let entityCount = 0;
  let segmentCount = 0;
  let textCount = 0;
  let insertCount = 0;

  const getBucket = (layerName: string) => {
    const existing = layerBuckets.get(layerName);
    if (existing) {
      return existing;
    }
    const sourceColor = document.layerMap[layerName]?.sourceColor ?? "#ffffff";
    const bucket = {
      sourceColor,
      linePositions: [],
      textItems: []
    };
    layerBuckets.set(layerName, bucket);
    return bucket;
  };

  const visitEntity = (
    entity: ParsedDxfEntity,
    currentTransform: Transform2D,
    inheritedLayerName: string | undefined,
    ancestry: string[],
    depth: number
  ) => {
    const effectiveLayerName = resolveEntityLayer(entity.layerName, inheritedLayerName);
    entityCount += 1;
    if (depth > MAX_INSERT_RECURSION_DEPTH) {
      warnings.push(`Block recursion depth exceeded at ${ancestry.join(" -> ")}`);
      return;
    }
    if (entity.type === "INSERT") {
      insertCount += 1;
      const block = document.blocks[entity.blockName];
      if (!block) {
        warnings.push(`Missing block definition: ${entity.blockName}`);
        return;
      }
      if (ancestry.includes(block.name)) {
        warnings.push(`Cyclic block reference: ${[...ancestry, block.name].join(" -> ")}`);
        return;
      }
      const nextAncestry = [...ancestry, block.name];
      for (let rowIndex = 0; rowIndex < entity.rowCount; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < entity.columnCount; columnIndex += 1) {
          const offset: [number, number] = [
            columnIndex * entity.columnSpacing,
            rowIndex * entity.rowSpacing
          ];
          const insertTransform = createInsertTransform(entity, block.basePoint, offset);
          const combined = multiplyTransform(currentTransform, insertTransform);
          for (const childEntity of block.entities) {
            visitEntity(childEntity, combined, effectiveLayerName, nextAncestry, depth + 1);
          }
        }
      }
      return;
    }

    const bucket = getBucket(effectiveLayerName);
    switch (entity.type) {
      case "LINE": {
        const a = applyTransform(currentTransform, entity.start[0], entity.start[1]);
        const b = applyTransform(currentTransform, entity.end[0], entity.end[1]);
        pushSegment(bucket.linePositions, mapPoint(a[0], a[1], options.drawingPlane), mapPoint(b[0], b[1], options.drawingPlane));
        segmentCount += 1;
        break;
      }
      case "LWPOLYLINE":
      case "POLYLINE":
        segmentCount += appendPolylineSegments(entity, currentTransform, options.drawingPlane, options.curveResolution, bucket.linePositions);
        break;
      case "CIRCLE": {
        const steps = Math.max(12, options.curveResolution);
        let previous = applyTransform(currentTransform, entity.center[0] + entity.radius, entity.center[1]);
        for (let index = 1; index <= steps; index += 1) {
          const angle = (index / steps) * Math.PI * 2;
          const next = applyTransform(
            currentTransform,
            entity.center[0] + Math.cos(angle) * entity.radius,
            entity.center[1] + Math.sin(angle) * entity.radius
          );
          pushSegment(bucket.linePositions, mapPoint(previous[0], previous[1], options.drawingPlane), mapPoint(next[0], next[1], options.drawingPlane));
          previous = next;
          segmentCount += 1;
        }
        break;
      }
      case "ARC": {
        const start = THREE.MathUtils.degToRad(entity.startAngleDeg);
        const end = THREE.MathUtils.degToRad(entity.endAngleDeg);
        const sweep = normalizeArcSweep(start, end);
        const steps = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * options.curveResolution));
        let previous = applyTransform(
          currentTransform,
          entity.center[0] + Math.cos(start) * entity.radius,
          entity.center[1] + Math.sin(start) * entity.radius
        );
        for (let index = 1; index <= steps; index += 1) {
          const angle = start + (index / steps) * sweep;
          const next = applyTransform(
            currentTransform,
            entity.center[0] + Math.cos(angle) * entity.radius,
            entity.center[1] + Math.sin(angle) * entity.radius
          );
          pushSegment(bucket.linePositions, mapPoint(previous[0], previous[1], options.drawingPlane), mapPoint(next[0], next[1], options.drawingPlane));
          previous = next;
          segmentCount += 1;
        }
        break;
      }
      case "ELLIPSE": {
        const majorLength = Math.hypot(entity.majorAxis[0], entity.majorAxis[1]);
        const ux = majorLength > 1e-9 ? entity.majorAxis[0] / majorLength : 1;
        const uy = majorLength > 1e-9 ? entity.majorAxis[1] / majorLength : 0;
        const vx = -uy;
        const vy = ux;
        const sweep = normalizeArcSweep(entity.startParameter, entity.endParameter);
        const steps = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * options.curveResolution));
        const minorLength = majorLength * entity.axisRatio;
        let previous = applyTransform(
          currentTransform,
          entity.center[0] + Math.cos(entity.startParameter) * majorLength * ux + Math.sin(entity.startParameter) * minorLength * vx,
          entity.center[1] + Math.cos(entity.startParameter) * majorLength * uy + Math.sin(entity.startParameter) * minorLength * vy
        );
        for (let index = 1; index <= steps; index += 1) {
          const angle = entity.startParameter + (index / steps) * sweep;
          const next = applyTransform(
            currentTransform,
            entity.center[0] + Math.cos(angle) * majorLength * ux + Math.sin(angle) * minorLength * vx,
            entity.center[1] + Math.cos(angle) * majorLength * uy + Math.sin(angle) * minorLength * vy
          );
          pushSegment(bucket.linePositions, mapPoint(previous[0], previous[1], options.drawingPlane), mapPoint(next[0], next[1], options.drawingPlane));
          previous = next;
          segmentCount += 1;
        }
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const position2 = applyTransform(currentTransform, entity.position[0], entity.position[1]);
        const dir2 = applyVector(
          currentTransform,
          Math.cos(THREE.MathUtils.degToRad(entity.rotationDeg)),
          Math.sin(THREE.MathUtils.degToRad(entity.rotationDeg))
        );
        const xScale = Math.hypot(currentTransform.a, currentTransform.b);
        const yScale = Math.hypot(currentTransform.c, currentTransform.d);
        bucket.textItems.push({
          text: entity.text,
          position: mapPoint(position2[0], position2[1], options.drawingPlane),
          rotationRadians: Math.atan2(dir2[1], dir2[0]),
          heightMeters: Math.max(0.001, entity.height * Math.max(xScale, yScale))
        });
        textCount += 1;
        break;
      }
    }
  };

  for (const entity of document.entities) {
    visitEntity(entity, transform, undefined, [], 0);
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
      sourceColor: bucket.sourceColor,
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
    entityCount,
    segmentCount,
    textCount,
    insertCount,
    blockCount: Object.keys(document.blocks).length,
    unsupportedEntityCounts: { ...document.unsupportedEntityCounts },
    warnings,
    layerOrder: layers.map((layer) => layer.layerName)
  };
}

function createTextMesh(args: TextMeshFactoryArgs): THREE.Mesh | null {
  const text = args.text.trim();
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

  const height = Math.max(args.heightMeters, 0.001) * Math.max(1, lines.length);
  const width = height * (canvas.width / Math.max(1, canvas.height));
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(width * 0.5, height * 0.5, 0);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    color: new THREE.Color(args.color),
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...args.position);
  const planeQuat = planeQuaternion(args.plane);
  const rotationQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), args.rotationRadians);
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
  root.name = "dxf-drawing-root";
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
      const mesh = createTextMesh({
        text: item.text,
        position: item.position,
        rotationRadians: item.rotationRadians,
        heightMeters: item.heightMeters,
        plane: appearance.drawingPlane,
        color: effectiveLayerColor(layer.layerName, layer.sourceColor, layerStates, appearance.invertColors)
      });
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

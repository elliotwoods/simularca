import * as THREE from "three";
import type { BeamBuildInput, PrimitiveDimensions, PrimitiveShape, SilhouetteResult } from "./contracts";

const EPSILON = 1e-6;
const BINARY_SEARCH_STEPS = 28;
const MAX_SILHOUETTE_HALF_ANGLE = Math.PI * 0.499;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getBoundingRadius(shape: PrimitiveShape, dimensions: PrimitiveDimensions): number {
  switch (shape) {
    case "sphere":
      return Math.max(EPSILON, dimensions.sphereRadius);
    case "cylinder":
      return Math.hypot(Math.max(0, dimensions.cylinderRadius), Math.max(0, dimensions.cylinderHeight * 0.5));
    case "cube":
    default:
      return Math.sqrt(3) * Math.max(0, dimensions.cubeSize) * 0.5;
  }
}

function buildEmitterBasis(viewDir: THREE.Vector3): { tangentU: THREE.Vector3; tangentV: THREE.Vector3 } {
  const reference = Math.abs(viewDir.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tangentU = new THREE.Vector3().crossVectors(viewDir, reference).normalize();
  const tangentV = new THREE.Vector3().crossVectors(tangentU, viewDir).normalize();
  return { tangentU, tangentV };
}

function pointInsidePrimitive(shape: PrimitiveShape, point: THREE.Vector3, dimensions: PrimitiveDimensions): boolean {
  switch (shape) {
    case "sphere": {
      const radius = Math.max(EPSILON, dimensions.sphereRadius);
      return point.lengthSq() < radius * radius - EPSILON;
    }
    case "cube": {
      const half = Math.max(EPSILON, dimensions.cubeSize * 0.5);
      return Math.abs(point.x) < half - EPSILON && Math.abs(point.y) < half - EPSILON && Math.abs(point.z) < half - EPSILON;
    }
    case "cylinder": {
      const radius = Math.max(EPSILON, dimensions.cylinderRadius);
      const halfHeight = Math.max(EPSILON, dimensions.cylinderHeight * 0.5);
      return point.x * point.x + point.z * point.z < radius * radius - EPSILON && Math.abs(point.y) < halfHeight - EPSILON;
    }
  }
}

function pointOnPrimitiveBoundary(shape: PrimitiveShape, point: THREE.Vector3, dimensions: PrimitiveDimensions): boolean {
  switch (shape) {
    case "sphere": {
      const radius = Math.max(EPSILON, dimensions.sphereRadius);
      return Math.abs(point.length() - radius) <= EPSILON;
    }
    case "cube": {
      const half = Math.max(EPSILON, dimensions.cubeSize * 0.5);
      const dx = Math.abs(Math.abs(point.x) - half);
      const dy = Math.abs(Math.abs(point.y) - half);
      const dz = Math.abs(Math.abs(point.z) - half);
      return dx <= EPSILON || dy <= EPSILON || dz <= EPSILON;
    }
    case "cylinder": {
      const radius = Math.max(EPSILON, dimensions.cylinderRadius);
      const halfHeight = Math.max(EPSILON, dimensions.cylinderHeight * 0.5);
      const radialDistance = Math.hypot(point.x, point.z);
      return Math.abs(radialDistance - radius) <= EPSILON || Math.abs(Math.abs(point.y) - halfHeight) <= EPSILON;
    }
  }
}

function intersectSphereRay(origin: THREE.Vector3, direction: THREE.Vector3, radius: number): number | null {
  const a = direction.dot(direction);
  const b = 2 * origin.dot(direction);
  const c = origin.dot(origin) - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }
  const sqrtDiscriminant = Math.sqrt(discriminant);
  const inv = 1 / (2 * a);
  const t0 = (-b - sqrtDiscriminant) * inv;
  const t1 = (-b + sqrtDiscriminant) * inv;
  if (t0 > EPSILON) {
    return t0;
  }
  if (t1 > EPSILON) {
    return t1;
  }
  return null;
}

function intersectBoxRay(origin: THREE.Vector3, direction: THREE.Vector3, halfExtent: number): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const o = origin[axis];
    const d = direction[axis];
    if (Math.abs(d) <= EPSILON) {
      if (Math.abs(o) > halfExtent) {
        return null;
      }
      continue;
    }
    const inv = 1 / d;
    let t0 = (-halfExtent - o) * inv;
    let t1 = (halfExtent - o) * inv;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) {
      return null;
    }
  }
  if (tMin > EPSILON) {
    return tMin;
  }
  if (tMax > EPSILON) {
    return tMax;
  }
  return null;
}

function intersectCappedCylinderRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius: number,
  halfHeight: number
): number | null {
  let best: number | null = null;
  const a = direction.x * direction.x + direction.z * direction.z;
  const b = 2 * (origin.x * direction.x + origin.z * direction.z);
  const c = origin.x * origin.x + origin.z * origin.z - radius * radius;
  if (a > EPSILON) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrtDiscriminant = Math.sqrt(discriminant);
      const inv = 1 / (2 * a);
      const candidates = [(-b - sqrtDiscriminant) * inv, (-b + sqrtDiscriminant) * inv];
      for (const t of candidates) {
        if (t <= EPSILON) {
          continue;
        }
        const y = origin.y + direction.y * t;
        if (y >= -halfHeight - EPSILON && y <= halfHeight + EPSILON) {
          best = best === null ? t : Math.min(best, t);
        }
      }
    }
  }

  if (Math.abs(direction.y) > EPSILON) {
    for (const capY of [-halfHeight, halfHeight]) {
      const t = (capY - origin.y) / direction.y;
      if (t <= EPSILON) {
        continue;
      }
      const x = origin.x + direction.x * t;
      const z = origin.z + direction.z * t;
      if (x * x + z * z <= radius * radius + EPSILON) {
        best = best === null ? t : Math.min(best, t);
      }
    }
  }
  return best;
}

function intersectPrimitiveRay(
  shape: PrimitiveShape,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  dimensions: PrimitiveDimensions
): number | null {
  switch (shape) {
    case "sphere":
      return intersectSphereRay(origin, direction, Math.max(EPSILON, dimensions.sphereRadius));
    case "cylinder":
      return intersectCappedCylinderRay(
        origin,
        direction,
        Math.max(EPSILON, dimensions.cylinderRadius),
        Math.max(EPSILON, dimensions.cylinderHeight * 0.5)
      );
    case "cube":
    default:
      return intersectBoxRay(origin, direction, Math.max(EPSILON, dimensions.cubeSize * 0.5));
  }
}

function hitsPrimitiveWorld(
  shape: PrimitiveShape,
  dimensions: PrimitiveDimensions,
  inverseTargetWorld: THREE.Matrix4,
  emitterWorld: THREE.Vector3,
  directionWorld: THREE.Vector3
): { hit: boolean; distance: number | null } {
  const emitterLocal = emitterWorld.clone().applyMatrix4(inverseTargetWorld);
  const linear = new THREE.Matrix3().setFromMatrix4(inverseTargetWorld);
  const directionLocal = directionWorld.clone().applyMatrix3(linear);
  const distance = intersectPrimitiveRay(shape, emitterLocal, directionLocal, dimensions);
  return {
    hit: distance !== null,
    distance
  };
}

export function computeSilhouetteWorld(input: BeamBuildInput): SilhouetteResult {
  const targetCenterWorld = new THREE.Vector3().setFromMatrixPosition(input.targetWorldMatrix);
  const toTarget = targetCenterWorld.clone().sub(input.emitterWorld);
  const targetDistance = toTarget.length();
  if (targetDistance <= EPSILON) {
    return {
      ok: false,
      reason: "Emitter coincides with target center.",
      contourWorld: [],
      targetCenterWorld
    };
  }

  const inverseTargetWorld = input.targetWorldMatrix.clone().invert();
  const emitterLocal = input.emitterWorld.clone().applyMatrix4(inverseTargetWorld);
  if (pointInsidePrimitive(input.shape, emitterLocal, input.dimensions) || pointOnPrimitiveBoundary(input.shape, emitterLocal, input.dimensions)) {
    return {
      ok: false,
      reason: "Emitter is inside or on the target primitive.",
      contourWorld: [],
      targetCenterWorld
    };
  }

  const viewDir = toTarget.normalize();
  const { tangentU, tangentV } = buildEmitterBasis(viewDir);
  const contourWorld: THREE.Vector3[] = [];
  const boundingRadius = getBoundingRadius(input.shape, input.dimensions);
  const initialUpper = clamp(Math.asin(clamp(boundingRadius / targetDistance, 0, 0.999999)) * 1.25 + 0.15, 0.05, MAX_SILHOUETTE_HALF_ANGLE);
  const resolution = Math.max(3, Math.floor(input.resolution));
  const centerHit = hitsPrimitiveWorld(input.shape, input.dimensions, inverseTargetWorld, input.emitterWorld, viewDir).hit;
  if (!centerHit) {
    return {
      ok: false,
      reason: "Emitter cannot see the target center ray.",
      contourWorld: [],
      targetCenterWorld
    };
  }

  for (let index = 0; index < resolution; index += 1) {
    const angle = (index / resolution) * Math.PI * 2;
    const radialDirection = tangentU.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangentV, Math.sin(angle)).normalize();

    let low = 0;
    let high = initialUpper;
    let highState = hitsPrimitiveWorld(
      input.shape,
      input.dimensions,
      inverseTargetWorld,
      input.emitterWorld,
      viewDir.clone().multiplyScalar(Math.cos(high)).addScaledVector(radialDirection, Math.sin(high)).normalize()
    ).hit;

    let expandCount = 0;
    while (highState && high < MAX_SILHOUETTE_HALF_ANGLE - EPSILON && expandCount < 16) {
      high = clamp(high * 1.5 + 0.05, 0.05, MAX_SILHOUETTE_HALF_ANGLE);
      highState = hitsPrimitiveWorld(
        input.shape,
        input.dimensions,
        inverseTargetWorld,
        input.emitterWorld,
        viewDir.clone().multiplyScalar(Math.cos(high)).addScaledVector(radialDirection, Math.sin(high)).normalize()
      ).hit;
      expandCount += 1;
    }

    if (highState) {
      return {
        ok: false,
        reason: "Failed to bracket the target silhouette.",
        contourWorld: [],
        targetCenterWorld
      };
    }

    for (let step = 0; step < BINARY_SEARCH_STEPS; step += 1) {
      const mid = (low + high) * 0.5;
      const midDirection = viewDir.clone().multiplyScalar(Math.cos(mid)).addScaledVector(radialDirection, Math.sin(mid)).normalize();
      const midHit = hitsPrimitiveWorld(input.shape, input.dimensions, inverseTargetWorld, input.emitterWorld, midDirection).hit;
      if (midHit) {
        low = mid;
      } else {
        high = mid;
      }
    }

    const finalDirection = viewDir.clone().multiplyScalar(Math.cos(low)).addScaledVector(radialDirection, Math.sin(low)).normalize();
    const finalHit = hitsPrimitiveWorld(
      input.shape,
      input.dimensions,
      inverseTargetWorld,
      input.emitterWorld,
      finalDirection
    );
    if (!finalHit.hit || finalHit.distance === null) {
      return {
        ok: false,
        reason: "Failed to resolve a silhouette hit point.",
        contourWorld: [],
        targetCenterWorld
      };
    }
    contourWorld.push(input.emitterWorld.clone().addScaledVector(finalDirection, finalHit.distance));
  }

  return {
    ok: true,
    contourWorld,
    targetCenterWorld
  };
}

export function buildBeamGeometryWorld(
  emitterWorld: THREE.Vector3,
  contourWorld: THREE.Vector3[],
  beamLength: number,
  rootWorldInverse: THREE.Matrix4
): THREE.BufferGeometry {
  const contourCount = contourWorld.length;
  const apexLocal = emitterWorld.clone().applyMatrix4(rootWorldInverse);
  const positions = new Float32Array(contourCount * 9);
  const emitterPositions = new Float32Array(contourCount * 9);

  for (let index = 0; index < contourCount; index += 1) {
    const contourPoint = contourWorld[index];
    if (!contourPoint) {
      continue;
    }
    const direction = contourPoint.clone().sub(emitterWorld);
    if (direction.lengthSq() <= EPSILON) {
      direction.set(0, 0, 1);
    } else {
      direction.normalize();
    }
    const nextContourPoint = contourWorld[index + 1 === contourCount ? 0 : index + 1];
    if (!nextContourPoint) {
      continue;
    }
    const nextDirection = nextContourPoint.clone().sub(emitterWorld);
    if (nextDirection.lengthSq() <= EPSILON) {
      nextDirection.set(0, 0, 1);
    } else {
      nextDirection.normalize();
    }
    const farPointLocal = emitterWorld.clone().addScaledVector(direction, beamLength).applyMatrix4(rootWorldInverse);
    const nextFarPointLocal = emitterWorld
      .clone()
      .addScaledVector(nextDirection, beamLength)
      .applyMatrix4(rootWorldInverse);

    const offset = index * 9;
    positions[offset] = apexLocal.x;
    positions[offset + 1] = apexLocal.y;
    positions[offset + 2] = apexLocal.z;
    positions[offset + 3] = farPointLocal.x;
    positions[offset + 4] = farPointLocal.y;
    positions[offset + 5] = farPointLocal.z;
    positions[offset + 6] = nextFarPointLocal.x;
    positions[offset + 7] = nextFarPointLocal.y;
    positions[offset + 8] = nextFarPointLocal.z;

    emitterPositions[offset] = emitterWorld.x;
    emitterPositions[offset + 1] = emitterWorld.y;
    emitterPositions[offset + 2] = emitterWorld.z;
    emitterPositions[offset + 3] = emitterWorld.x;
    emitterPositions[offset + 4] = emitterWorld.y;
    emitterPositions[offset + 5] = emitterWorld.z;
    emitterPositions[offset + 6] = emitterWorld.x;
    emitterPositions[offset + 7] = emitterWorld.y;
    emitterPositions[offset + 8] = emitterWorld.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("beamEmitterPosition", new THREE.BufferAttribute(emitterPositions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildCombinedBeamGeometryWorld(
  placements: Array<{ emitterWorld: THREE.Vector3; contourWorld: THREE.Vector3[] }>,
  beamLength: number,
  rootWorldInverse: THREE.Matrix4
): THREE.BufferGeometry {
  const totalTriangles = placements.reduce((sum, placement) => sum + placement.contourWorld.length, 0);
  const positions = new Float32Array(totalTriangles * 9);
  const emitterPositions = new Float32Array(totalTriangles * 9);

  let triangleBase = 0;
  for (const placement of placements) {
    const apexLocal = placement.emitterWorld.clone().applyMatrix4(rootWorldInverse);
    for (let contourIndex = 0; contourIndex < placement.contourWorld.length; contourIndex += 1) {
      const contourPoint = placement.contourWorld[contourIndex];
      if (!contourPoint) {
        continue;
      }
      const direction = contourPoint.clone().sub(placement.emitterWorld);
      if (direction.lengthSq() <= EPSILON) {
        direction.set(0, 0, 1);
      } else {
        direction.normalize();
      }
      const nextContourPoint =
        placement.contourWorld[contourIndex + 1 === placement.contourWorld.length ? 0 : contourIndex + 1];
      if (!nextContourPoint) {
        continue;
      }
      const nextDirection = nextContourPoint.clone().sub(placement.emitterWorld);
      if (nextDirection.lengthSq() <= EPSILON) {
        nextDirection.set(0, 0, 1);
      } else {
        nextDirection.normalize();
      }
      const farPointLocal = placement.emitterWorld.clone().addScaledVector(direction, beamLength).applyMatrix4(rootWorldInverse);
      const nextFarPointLocal = placement.emitterWorld
        .clone()
        .addScaledVector(nextDirection, beamLength)
        .applyMatrix4(rootWorldInverse);

      const triangleOffset = (triangleBase + contourIndex) * 9;
      positions[triangleOffset] = apexLocal.x;
      positions[triangleOffset + 1] = apexLocal.y;
      positions[triangleOffset + 2] = apexLocal.z;
      positions[triangleOffset + 3] = farPointLocal.x;
      positions[triangleOffset + 4] = farPointLocal.y;
      positions[triangleOffset + 5] = farPointLocal.z;
      positions[triangleOffset + 6] = nextFarPointLocal.x;
      positions[triangleOffset + 7] = nextFarPointLocal.y;
      positions[triangleOffset + 8] = nextFarPointLocal.z;

      emitterPositions[triangleOffset] = placement.emitterWorld.x;
      emitterPositions[triangleOffset + 1] = placement.emitterWorld.y;
      emitterPositions[triangleOffset + 2] = placement.emitterWorld.z;
      emitterPositions[triangleOffset + 3] = placement.emitterWorld.x;
      emitterPositions[triangleOffset + 4] = placement.emitterWorld.y;
      emitterPositions[triangleOffset + 5] = placement.emitterWorld.z;
      emitterPositions[triangleOffset + 6] = placement.emitterWorld.x;
      emitterPositions[triangleOffset + 7] = placement.emitterWorld.y;
      emitterPositions[triangleOffset + 8] = placement.emitterWorld.z;
    }
    triangleBase += placement.contourWorld.length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("beamEmitterPosition", new THREE.BufferAttribute(emitterPositions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function sampleArcLengthCurveTs(
  count: number,
  closed: boolean,
  sampleWorldPoint: (t: number) => THREE.Vector3 | null,
  lutSamples: number
): number[] {
  const safeCount = Math.max(1, Math.floor(count));
  if (!closed && safeCount === 1) {
    return [0];
  }

  const sampleCount = Math.max(8, Math.floor(lutSamples));
  const cumulative: Array<{ t: number; length: number }> = [{ t: 0, length: 0 }];
  let previous = sampleWorldPoint(0);
  if (!previous) {
    return [];
  }
  let totalLength = 0;
  for (let index = 1; index <= sampleCount; index += 1) {
    const t = index / sampleCount;
    const current = sampleWorldPoint(t);
    if (!current) {
      continue;
    }
    totalLength += current.distanceTo(previous);
    cumulative.push({ t, length: totalLength });
    previous = current;
  }

  if (totalLength <= EPSILON) {
    return closed
      ? Array.from({ length: safeCount }, (_, index) => index / safeCount)
      : Array.from({ length: safeCount }, (_, index) => (safeCount === 1 ? 0 : index / (safeCount - 1)));
  }

  const targets = closed
    ? Array.from({ length: safeCount }, (_, index) => (index / safeCount) * totalLength)
    : Array.from({ length: safeCount }, (_, index) => (safeCount === 1 ? 0 : (index / (safeCount - 1)) * totalLength));

  const result: number[] = [];
  let lookupIndex = 1;
  for (const targetLength of targets) {
    while (lookupIndex < cumulative.length && (cumulative[lookupIndex]?.length ?? Number.POSITIVE_INFINITY) < targetLength) {
      lookupIndex += 1;
    }
    const upper = cumulative[Math.min(lookupIndex, cumulative.length - 1)];
    const lower = cumulative[Math.max(0, lookupIndex - 1)];
    if (!upper || !lower) {
      continue;
    }
    const span = upper.length - lower.length;
    if (span <= EPSILON) {
      result.push(upper.t);
      continue;
    }
    const localT = (targetLength - lower.length) / span;
    result.push(lower.t + (upper.t - lower.t) * localT);
  }
  return result;
}

import * as THREE from "three";
import type { ActorNode, DimensionAxis, Landmark, ParameterValues } from "@/core/types";
import { readLandmark, resolveDimensionAxis } from "@/features/dimensions/model";

/**
 * Pure, render-agnostic geometry for dimension actors. Resolves landmarks to
 * world space and derives the measure-line points (extension feet + span) shared
 * by the live overlay controller (`DimensionOverlayController`) and the vector
 * print exporter. Keeping it here means both produce identical geometry.
 *
 * `ActorObjectResolver` maps an actor id to its scene object so local-space
 * landmarks (`actor` / `line`) can be transformed to world space. The live
 * controller passes its scene controller's lookup; the print path passes the
 * offscreen viewport's.
 */
export type ActorObjectResolver = (actorId: string) => THREE.Object3D | null;

export interface DimensionWorldGeometry {
  A: THREE.Vector3;
  B: THREE.Vector3;
  axis: DimensionAxis;
  m1: THREE.Vector3;
  m2: THREE.Vector3;
  distance: number;
  labelPos: THREE.Vector3;
  lineDir: THREE.Vector3;
}

export function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

export function axisIndexOf(axis: DimensionAxis): number {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

export function axisUnit(axis: DimensionAxis): THREE.Vector3 {
  return new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Foot of the perpendicular from point P onto the infinite line through (p0, dir). */
export function footOnLine(p: THREE.Vector3, p0: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
  const d = dir.clone();
  const lenSq = d.lengthSq();
  if (lenSq <= 1e-12) {
    return p0.clone();
  }
  const t = p.clone().sub(p0).dot(d) / lenSq;
  return p0.clone().addScaledVector(d, t);
}

/**
 * Closest points between two finite segments (Ericson, Real-Time Collision
 * Detection). Returns the point on each segment nearest the other.
 */
export function closestPointsBetweenSegments(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3
): { c1: THREE.Vector3; c2: THREE.Vector3 } {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return { c1: p1.clone().addScaledVector(d1, s), c2: p2.clone().addScaledVector(d2, t) };
}

export function resolveLandmarkWorld(landmark: Landmark | null, resolve: ActorObjectResolver): THREE.Vector3 | null {
  if (!landmark) {
    return null;
  }
  if (landmark.kind === "origin") {
    return new THREE.Vector3(0, 0, 0);
  }
  if (landmark.kind === "world") {
    return new THREE.Vector3(landmark.point[0], landmark.point[1], landmark.point[2]);
  }
  if (landmark.kind === "line") {
    // Fallback point for a line landmark (annotation anchor / offset handle): its midpoint.
    const line = resolveLandmarkLine(landmark, resolve);
    return line ? line.a.clone().add(line.b).multiplyScalar(0.5) : null;
  }
  const object = resolve(landmark.actorId);
  if (!(object instanceof THREE.Object3D)) {
    return null;
  }
  object.updateWorldMatrix(true, false);
  return object.localToWorld(new THREE.Vector3(landmark.localOffset[0], landmark.localOffset[1], landmark.localOffset[2]));
}

/** Resolve a line landmark to its world-space endpoints + direction (live-follow). */
export function resolveLandmarkLine(
  landmark: Landmark | null,
  resolve: ActorObjectResolver
): { p0: THREE.Vector3; dir: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 } | null {
  if (!landmark || landmark.kind !== "line") {
    return null;
  }
  const object = resolve(landmark.actorId);
  if (!(object instanceof THREE.Object3D)) {
    return null;
  }
  object.updateWorldMatrix(true, false);
  const a = object.localToWorld(new THREE.Vector3(landmark.a[0], landmark.a[1], landmark.a[2]));
  const b = object.localToWorld(new THREE.Vector3(landmark.b[0], landmark.b[1], landmark.b[2]));
  return { p0: a.clone(), dir: b.clone().sub(a), a, b };
}

/**
 * Resolve the two world points a dimension measures between. When a line
 * landmark is involved the measure is orthogonal: line→point drops a
 * perpendicular from the point onto the line; line→line uses the closest
 * points between the two lines.
 */
export function resolveMeasureEndpoints(
  start: Landmark | null,
  end: Landmark | null,
  resolve: ActorObjectResolver
): { A: THREE.Vector3; B: THREE.Vector3; perpendicular: boolean } | null {
  const startLine = start?.kind === "line" ? resolveLandmarkLine(start, resolve) : null;
  const endLine = end?.kind === "line" ? resolveLandmarkLine(end, resolve) : null;
  if (startLine && endLine) {
    const { c1, c2 } = closestPointsBetweenSegments(startLine.a, startLine.b, endLine.a, endLine.b);
    return { A: c1, B: c2, perpendicular: true };
  }
  if (startLine) {
    const P = resolveLandmarkWorld(end, resolve);
    return P ? { A: footOnLine(P, startLine.p0, startLine.dir), B: P, perpendicular: true } : null;
  }
  if (endLine) {
    const P = resolveLandmarkWorld(start, resolve);
    return P ? { A: P, B: footOnLine(P, endLine.p0, endLine.dir), perpendicular: true } : null;
  }
  const A = resolveLandmarkWorld(start, resolve);
  const B = resolveLandmarkWorld(end, resolve);
  return A && B ? { A, B, perpendicular: false } : null;
}

/** Offset vector O for a dimension's measure line, from offsetDir × extensionGap (with fallback). */
export function resolveOffsetVector(params: ParameterValues, axis: DimensionAxis): THREE.Vector3 {
  const mag = Number.isFinite(Number(params.extensionGap)) ? Math.max(0, Number(params.extensionGap)) : 0.25;
  const dirRaw = params.offsetDir;
  if (isVec3(dirRaw)) {
    const dir = new THREE.Vector3(dirRaw[0], dirRaw[1], dirRaw[2]);
    if (dir.lengthSq() > 1e-12) {
      return dir.normalize().multiplyScalar(mag);
    }
  }
  if (axis === "direct") {
    return new THREE.Vector3(0, 0, 0);
  }
  const perp = axis === "y" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return perp.multiplyScalar(mag);
}

/** Derive a dimension's world-space measure geometry (extension feet + span + label point). */
export function computeDimensionWorldGeometry(
  actor: ActorNode,
  resolve: ActorObjectResolver
): DimensionWorldGeometry | null {
  const measure = resolveMeasureEndpoints(readLandmark(actor.params.start), readLandmark(actor.params.end), resolve);
  if (!measure) {
    return null;
  }
  const { A, B, perpendicular } = measure;
  // A line landmark forces an orthogonal (direct between the derived points) measure.
  const axis = perpendicular ? "direct" : resolveDimensionAxis(actor.params.axis);
  const O = resolveOffsetVector(actor.params, axis);
  let along: THREE.Vector3;
  let lineDir: THREE.Vector3;
  if (axis === "direct") {
    along = B.clone().sub(A);
    lineDir = along.lengthSq() > 1e-12 ? along.clone().normalize() : new THREE.Vector3(1, 0, 0);
  } else {
    const i = axisIndexOf(axis);
    along = new THREE.Vector3();
    along.setComponent(i, B.getComponent(i) - A.getComponent(i));
    lineDir = axisUnit(axis);
  }
  const m1 = A.clone().add(O);
  const m2 = m1.clone().add(along);
  return {
    A,
    B,
    axis,
    m1,
    m2,
    distance: along.length(),
    labelPos: m1.clone().add(m2).multiplyScalar(0.5),
    lineDir
  };
}

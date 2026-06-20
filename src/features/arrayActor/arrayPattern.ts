import * as THREE from "three";
import type { ParameterValues, TransformTRS } from "@/core/types";

/**
 * Pure placement math for the Array actor. Given the array's parameters (and,
 * for the along-curve pattern, a curve sampler that returns points already in
 * the array actor's local space), produce one local-space placement matrix per
 * instance. The reconciler composes each placement with a template root's own
 * local transform via {@link composeInstanceTransform}.
 *
 * Orientation convention: when a pattern orients its instances, the instance's
 * local -Z axis is aligned with the pattern direction (radially outward for
 * circular, the curve tangent for along-curve) — matching THREE's lookAt
 * convention and the Source Four fixture's -Z aim. Linear/grid never rotate.
 */

export const MAX_INSTANCES_PER_ARRAY = 1024;

export type ArrayPatternKind = "linear" | "grid" | "circular" | "along-curve";
export type ArrayAxis = "x" | "y" | "z";

export interface ArrayParams {
  pattern: ArrayPatternKind;
  // linear
  linearCount: number;
  linearExtent: [number, number, number];
  linearCentered: boolean;
  // grid
  gridCountX: number;
  gridCountY: number;
  gridCountZ: number;
  gridSize: [number, number, number];
  gridCentered: boolean;
  // circular
  circularCount: number;
  circularRadius: number;
  circularAxis: ArrayAxis;
  circularArcStartDeg: number;
  circularArcEndDeg: number;
  circularFaceOutward: boolean;
  // along-curve
  curveActorId: string;
  curveCount: number;
  curveTStart: number;
  curveTEnd: number;
  curveOrientToTangent: boolean;
}

export interface CurveSample {
  position: [number, number, number];
  tangent: [number, number, number];
}

/** Samples a curve at parameter t∈[0,1], returning points in the array's local space. */
export type LocalCurveSampler = (t: number) => CurveSample | null;

const DEG2RAD = Math.PI / 180;

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function int(value: unknown, fallback: number, min: number): number {
  const n = Math.round(num(value, fallback));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])];
  }
  return [...fallback];
}

function pattern(value: unknown): ArrayPatternKind {
  return value === "grid" || value === "circular" || value === "along-curve" ? value : "linear";
}

function axis(value: unknown): ArrayAxis {
  return value === "x" || value === "z" ? value : "y";
}

export function readArrayParams(params: ParameterValues): ArrayParams {
  return {
    pattern: pattern(params.pattern),
    linearCount: int(params.linearCount, 5, 0),
    linearExtent: vec3(params.linearExtent, [2, 0, 0]),
    linearCentered: bool(params.linearCentered, true),
    gridCountX: int(params.gridCountX, 3, 1),
    gridCountY: int(params.gridCountY, 1, 1),
    gridCountZ: int(params.gridCountZ, 3, 1),
    gridSize: vec3(params.gridSize, [1, 1, 1]),
    gridCentered: bool(params.gridCentered, true),
    circularCount: int(params.circularCount, 8, 0),
    circularRadius: Math.max(0, num(params.circularRadius, 2)),
    circularAxis: axis(params.circularAxis),
    circularArcStartDeg: num(params.circularArcStartDeg, 0),
    circularArcEndDeg: num(params.circularArcEndDeg, 360),
    circularFaceOutward: bool(params.circularFaceOutward, true),
    curveActorId: typeof params.curveActorId === "string" ? params.curveActorId : "",
    curveCount: int(params.curveCount, 10, 0),
    curveTStart: clamp01(num(params.curveTStart, 0)),
    curveTEnd: clamp01(num(params.curveTEnd, 1)),
    curveOrientToTangent: bool(params.curveOrientToTangent, true)
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** How many instances the pattern will produce, capped at {@link MAX_INSTANCES_PER_ARRAY}. */
export function computeInstanceCount(p: ArrayParams): number {
  let count: number;
  switch (p.pattern) {
    case "linear":
      count = p.linearCount;
      break;
    case "grid":
      count = p.gridCountX * p.gridCountY * p.gridCountZ;
      break;
    case "circular":
      count = p.circularCount;
      break;
    case "along-curve":
      count = p.curveCount;
      break;
  }
  return Math.max(0, Math.min(MAX_INSTANCES_PER_ARRAY, count));
}

function translationMatrix(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

/** Build a matrix at `position` whose -Z axis points along `forward`, up = `up`. */
function orientedMatrix(
  position: THREE.Vector3,
  forward: THREE.Vector3,
  up: THREE.Vector3
): THREE.Matrix4 {
  if (forward.lengthSq() < 1e-12) {
    return new THREE.Matrix4().setPosition(position);
  }
  const target = position.clone().add(forward);
  let safeUp = up;
  if (Math.abs(forward.clone().normalize().dot(up.clone().normalize())) > 1 - 1e-6) {
    // up parallel to forward — pick a different stable up.
    safeUp = Math.abs(forward.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  }
  const m = new THREE.Matrix4().lookAt(position, target, safeUp);
  m.setPosition(position);
  return m;
}

function axisVector(a: ArrayAxis): THREE.Vector3 {
  if (a === "x") return new THREE.Vector3(1, 0, 0);
  if (a === "z") return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(0, 1, 0);
}

/** Two orthonormal in-plane basis vectors for a circle whose normal is `a`. */
function inPlaneBasis(a: ArrayAxis): [THREE.Vector3, THREE.Vector3] {
  if (a === "y") return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  if (a === "z") return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]; // axis x
}

/**
 * Local-space placement matrices, one per instance, in the array actor's space.
 * `sampleCurveLocal` is required for (and only used by) the along-curve pattern.
 */
export function computePlacements(p: ArrayParams, sampleCurveLocal?: LocalCurveSampler): THREE.Matrix4[] {
  switch (p.pattern) {
    case "linear":
      return linearPlacements(p);
    case "grid":
      return gridPlacements(p);
    case "circular":
      return circularPlacements(p);
    case "along-curve":
      return curvePlacements(p, sampleCurveLocal);
  }
}

function linearPlacements(p: ArrayParams): THREE.Matrix4[] {
  const count = Math.min(MAX_INSTANCES_PER_ARRAY, Math.max(0, p.linearCount));
  const [ex, ey, ez] = p.linearExtent;
  const shift = p.linearCentered ? 0.5 : 0;
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = count > 1 ? i / (count - 1) : shift;
    const f = s - shift;
    out.push(translationMatrix(f * ex, f * ey, f * ez));
  }
  return out;
}

function gridPlacements(p: ArrayParams): THREE.Matrix4[] {
  const nx = Math.max(1, p.gridCountX);
  const ny = Math.max(1, p.gridCountY);
  const nz = Math.max(1, p.gridCountZ);
  const [sx, sy, sz] = p.gridSize;
  const cx = p.gridCentered ? (nx - 1) / 2 : 0;
  const cy = p.gridCentered ? (ny - 1) / 2 : 0;
  const cz = p.gridCentered ? (nz - 1) / 2 : 0;
  const out: THREE.Matrix4[] = [];
  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        if (out.length >= MAX_INSTANCES_PER_ARRAY) {
          return out;
        }
        out.push(translationMatrix((ix - cx) * sx, (iy - cy) * sy, (iz - cz) * sz));
      }
    }
  }
  return out;
}

function circularPlacements(p: ArrayParams): THREE.Matrix4[] {
  const count = Math.min(MAX_INSTANCES_PER_ARRAY, Math.max(0, p.circularCount));
  const [e1, e2] = inPlaneBasis(p.circularAxis);
  const up = axisVector(p.circularAxis);
  const spanDeg = p.circularArcEndDeg - p.circularArcStartDeg;
  const fullCircle = Math.abs(((spanDeg % 360) + 360) % 360) < 1e-6 && Math.abs(spanDeg) >= 1e-6;
  const denom = fullCircle ? count : Math.max(1, count - 1);
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i += 1) {
    const frac = count > 1 ? i / denom : 0;
    const angle = (p.circularArcStartDeg + spanDeg * frac) * DEG2RAD;
    const position = new THREE.Vector3()
      .addScaledVector(e1, Math.cos(angle) * p.circularRadius)
      .addScaledVector(e2, Math.sin(angle) * p.circularRadius);
    if (p.circularFaceOutward && p.circularRadius > 1e-9) {
      out.push(orientedMatrix(position, position.clone().normalize(), up));
    } else {
      out.push(new THREE.Matrix4().setPosition(position));
    }
  }
  return out;
}

function curvePlacements(p: ArrayParams, sampleCurveLocal?: LocalCurveSampler): THREE.Matrix4[] {
  const count = Math.min(MAX_INSTANCES_PER_ARRAY, Math.max(0, p.curveCount));
  if (count === 0 || !sampleCurveLocal) {
    return [];
  }
  const worldUp = new THREE.Vector3(0, 1, 0);
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i += 1) {
    const frac = count > 1 ? i / (count - 1) : 0;
    const t = p.curveTStart + (p.curveTEnd - p.curveTStart) * frac;
    const sample = sampleCurveLocal(t);
    if (!sample) {
      out.push(new THREE.Matrix4());
      continue;
    }
    const position = new THREE.Vector3(...sample.position);
    if (p.curveOrientToTangent) {
      out.push(orientedMatrix(position, new THREE.Vector3(...sample.tangent), worldUp));
    } else {
      out.push(new THREE.Matrix4().setPosition(position));
    }
  }
  return out;
}

function localMatrix(transform: TransformTRS): THREE.Matrix4 {
  const position = new THREE.Vector3(...transform.position);
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation, "XYZ"));
  const scale = new THREE.Vector3(...transform.scale);
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

/**
 * Compose a placement matrix (array-local) with a template root's own local
 * transform, yielding the TRS to store on the generated instance root. Children
 * keep their template-local transforms; THREE composes the rest.
 */
export function composeInstanceTransform(placement: THREE.Matrix4, templateRoot: TransformTRS): TransformTRS {
  const final = placement.clone().multiply(localMatrix(templateRoot));
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  final.decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    position: [position.x, position.y, position.z],
    rotation: [euler.x, euler.y, euler.z],
    scale: [scale.x, scale.y, scale.z]
  };
}

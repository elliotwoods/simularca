import type { CurveData } from "@/features/curves/types";
import { getEffectiveCurveHandlesAt } from "@/features/curves/handles";

function add3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

function cubicBezier(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
  t: number
): [number, number, number] {
  const q0 = lerp3(p0, p1, t);
  const q1 = lerp3(p1, p2, t);
  const q2 = lerp3(p2, p3, t);
  const r0 = lerp3(q0, q1, t);
  const r1 = lerp3(q1, q2, t);
  return lerp3(r0, r1, t);
}

function cubicBezierTangent(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
  t: number
): [number, number, number] {
  const inv = 1 - t;
  return [
    3 * inv * inv * (p1[0] - p0[0]) + 6 * inv * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
    3 * inv * inv * (p1[1] - p0[1]) + 6 * inv * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
    3 * inv * inv * (p1[2] - p0[2]) + 6 * inv * t * (p2[2] - p1[2]) + 3 * t * t * (p3[2] - p2[2])
  ];
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const mag = Math.hypot(v[0], v[1], v[2]);
  if (mag <= 1e-9) {
    return [0, 0, 0];
  }
  return [v[0] / mag, v[1] / mag, v[2] / mag];
}

function isCircleCurve(curve: CurveData): boolean {
  return curve.kind === "circle";
}

function getCircleRadius(curve: CurveData): number {
  const parsed = Number(curve.radius);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

function enabledCurve(curve: CurveData): CurveData {
  if (isCircleCurve(curve)) {
    return {
      kind: "circle",
      closed: true,
      points: [],
      radius: getCircleRadius(curve)
    };
  }
  return {
    kind: "spline",
    closed: curve.closed,
    points: curve.points.filter((point) => point.enabled !== false)
  };
}

function segmentCount(curve: CurveData): number {
  const pointCount = curve.points.length;
  if (pointCount < 2) {
    return 0;
  }
  return curve.closed ? pointCount : pointCount - 1;
}

function segmentControls(curve: CurveData, segmentIndex: number): {
  p0: [number, number, number];
  p1: [number, number, number];
  p2: [number, number, number];
  p3: [number, number, number];
} {
  const count = curve.points.length;
  const current = curve.points[segmentIndex % count];
  const next = curve.points[(segmentIndex + 1) % count];
  if (!current || !next) {
    return {
      p0: [0, 0, 0],
      p1: [0, 0, 0],
      p2: [0, 0, 0],
      p3: [0, 0, 0]
    };
  }
  const currentHandles = getEffectiveCurveHandlesAt(curve, segmentIndex % count);
  const nextHandles = getEffectiveCurveHandlesAt(curve, (segmentIndex + 1) % count);
  return {
    p0: current.position,
    p1: add3(current.position, currentHandles.handleOut),
    p2: add3(next.position, nextHandles.handleIn),
    p3: next.position
  };
}

function mapGlobalT(curve: CurveData, t: number): { segmentIndex: number; segmentT: number } {
  const segCount = segmentCount(curve);
  if (segCount <= 0) {
    return { segmentIndex: 0, segmentT: 0 };
  }
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  if (clamped >= 1) {
    return { segmentIndex: segCount - 1, segmentT: 1 };
  }
  const value = clamped * segCount;
  const segmentIndex = Math.min(segCount - 1, Math.floor(value));
  const segmentT = value - segmentIndex;
  return { segmentIndex, segmentT };
}

export function sampleCurvePosition(curve: CurveData, t: number): [number, number, number] {
  curve = enabledCurve(curve);
  if (isCircleCurve(curve)) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
    const angle = clamped * Math.PI * 2;
    const radius = getCircleRadius(curve);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
  }
  if (curve.points.length === 0) {
    return [0, 0, 0];
  }
  if (curve.points.length === 1) {
    const only = curve.points[0];
    return only ? [...only.position] : [0, 0, 0];
  }
  const mapped = mapGlobalT(curve, t);
  const controls = segmentControls(curve, mapped.segmentIndex);
  return cubicBezier(controls.p0, controls.p1, controls.p2, controls.p3, mapped.segmentT);
}

export function sampleCurveTangent(curve: CurveData, t: number): [number, number, number] {
  curve = enabledCurve(curve);
  if (isCircleCurve(curve)) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
    const angle = clamped * Math.PI * 2;
    return normalize3([-Math.sin(angle), Math.cos(angle), 0]);
  }
  if (curve.points.length < 2) {
    return [1, 0, 0];
  }
  const mapped = mapGlobalT(curve, t);
  const controls = segmentControls(curve, mapped.segmentIndex);
  return normalize3(cubicBezierTangent(controls.p0, controls.p1, controls.p2, controls.p3, mapped.segmentT));
}

export function sampleCurvePositionAndTangent(
  curve: CurveData,
  t: number
): { position: [number, number, number]; tangent: [number, number, number] } {
  return {
    position: sampleCurvePosition(curve, t),
    tangent: sampleCurveTangent(curve, t)
  };
}

export function estimateCurveLength(curve: CurveData, samplesPerSegment = 24): number {
  curve = enabledCurve(curve);
  if (isCircleCurve(curve)) {
    return Math.PI * 2 * getCircleRadius(curve);
  }
  const segCount = segmentCount(curve);
  if (segCount <= 0) {
    return 0;
  }
  const samples = Math.max(2, Math.floor(samplesPerSegment));
  let length = 0;

  for (let segmentIndex = 0; segmentIndex < segCount; segmentIndex += 1) {
    const controls = segmentControls(curve, segmentIndex);
    let previous = controls.p0;
    for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex += 1) {
      const t = sampleIndex / samples;
      const current = cubicBezier(controls.p0, controls.p1, controls.p2, controls.p3, t);
      const delta = sub3(current, previous);
      length += Math.hypot(delta[0], delta[1], delta[2]);
      previous = current;
    }
  }

  return length;
}

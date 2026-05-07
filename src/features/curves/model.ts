import type { ActorNode } from "@/core/types";
import { getProjectedPolyline } from "@/features/curves/projectionCache";
import { createCircleCurveData, createDefaultCurveData, sanitizeCurveData, type CurveData, type CurveKind } from "@/features/curves/types";

export function getCurveTypeFromActor(actor: ActorNode): CurveKind {
  if (actor.params.curveType === "circle") return "circle";
  if (actor.params.curveType === "mesh-projection") return "mesh-projection";
  return "spline";
}

export function getCurveRadiusFromActor(actor: ActorNode): number {
  const parsed = Number(actor.params.radius);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(0, parsed);
}

export function getCurveDataFromActor(actor: ActorNode): CurveData {
  const kind = getCurveTypeFromActor(actor);
  if (kind === "circle") {
    return createCircleCurveData(getCurveRadiusFromActor(actor));
  }
  if (kind === "mesh-projection") {
    return { kind: "mesh-projection", closed: true, points: [] };
  }
  const fallback = createDefaultCurveData();
  const source = actor.params.curveData;
  return sanitizeCurveData(source, fallback);
}

export function getCurveClosedFromActor(actor: ActorNode): boolean {
  const kind = getCurveTypeFromActor(actor);
  if (kind === "circle" || kind === "mesh-projection") {
    return true;
  }
  const fromParam = actor.params.closed;
  if (typeof fromParam === "boolean") {
    return fromParam;
  }
  return getCurveDataFromActor(actor).closed;
}

export function getCurveSamplesPerSegmentFromActor(actor: ActorNode): number {
  const fromParam = Number(actor.params.samplesPerSegment);
  if (!Number.isFinite(fromParam)) {
    return 24;
  }
  return Math.max(2, Math.min(256, Math.floor(fromParam)));
}

export function curveDataWithOverrides(actor: ActorNode): CurveData {
  const curveData = getCurveDataFromActor(actor);
  curveData.kind = getCurveTypeFromActor(actor);
  curveData.closed = getCurveClosedFromActor(actor);
  if (curveData.kind === "circle") {
    curveData.radius = getCurveRadiusFromActor(actor);
  }
  return curveData;
}

export function buildSampleableCurveData(actor: ActorNode): CurveData {
  const data = curveDataWithOverrides(actor);
  if (data.kind === "mesh-projection") {
    const cached = getProjectedPolyline(actor.id);
    data.projectedPoints = cached?.points ?? [];
  }
  return data;
}

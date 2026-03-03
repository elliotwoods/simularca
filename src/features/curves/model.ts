import type { ActorNode } from "@/core/types";
import { createDefaultCurveData, sanitizeCurveData, type CurveData } from "@/features/curves/types";

export function getCurveDataFromActor(actor: ActorNode): CurveData {
  const fallback = createDefaultCurveData();
  const source = actor.params.curveData;
  return sanitizeCurveData(source, fallback);
}

export function getCurveClosedFromActor(actor: ActorNode): boolean {
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
  curveData.closed = getCurveClosedFromActor(actor);
  return curveData;
}

import type { ActorNode } from "@/core/types";
import { getProjectedPolyline } from "@/features/curves/projectionCache";
import {
  createArcCurveData,
  createCircleCurveData,
  createDefaultCurveData,
  createHelixCurveData,
  sanitizeCurveData,
  type CurveData,
  type CurveKind
} from "@/features/curves/types";

export function getCurveTypeFromActor(actor: ActorNode): CurveKind {
  if (actor.params.curveType === "circle") return "circle";
  if (actor.params.curveType === "arc") return "arc";
  if (actor.params.curveType === "helix") return "helix";
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

export function getCurveArcFractionFromActor(actor: ActorNode): number {
  const parsed = Number(actor.params.arcFraction);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(0, Math.min(1, parsed));
}

export function getCurveArcCenteredFromActor(actor: ActorNode): boolean {
  return Boolean(actor.params.arcCentered);
}

export function getCurveHelixParamsFromActor(actor: ActorNode): { pitch: number; turns: number } {
  const pitchRaw = Number(actor.params.helixPitch);
  const turnsRaw = Number(actor.params.helixTurns);
  return {
    pitch: Number.isFinite(pitchRaw) ? Math.max(0, pitchRaw) : 1,
    turns: Number.isFinite(turnsRaw) ? Math.max(0.01, turnsRaw) : 1
  };
}

export function getCurveDataFromActor(actor: ActorNode): CurveData {
  const kind = getCurveTypeFromActor(actor);
  if (kind === "circle") {
    return createCircleCurveData(getCurveRadiusFromActor(actor));
  }
  if (kind === "arc") {
    return createArcCurveData(
      getCurveRadiusFromActor(actor),
      getCurveArcFractionFromActor(actor),
      getCurveArcCenteredFromActor(actor)
    );
  }
  if (kind === "helix") {
    const { pitch, turns } = getCurveHelixParamsFromActor(actor);
    return createHelixCurveData(getCurveRadiusFromActor(actor), pitch, turns);
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
  if (kind === "arc") {
    return getCurveArcFractionFromActor(actor) >= 1;
  }
  if (kind === "helix") {
    return false;
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
  } else if (curveData.kind === "arc") {
    curveData.radius = getCurveRadiusFromActor(actor);
    curveData.arcFraction = getCurveArcFractionFromActor(actor);
    curveData.arcCentered = getCurveArcCenteredFromActor(actor);
  } else if (curveData.kind === "helix") {
    const { pitch, turns } = getCurveHelixParamsFromActor(actor);
    curveData.radius = getCurveRadiusFromActor(actor);
    curveData.helixPitch = pitch;
    curveData.helixTurns = turns;
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

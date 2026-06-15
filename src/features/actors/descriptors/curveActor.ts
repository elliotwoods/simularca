import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import type { ActorNode, AppState } from "@/core/types";
import { CURVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import {
  curveDataWithOverrides,
  getCurveArcCenteredFromActor,
  getCurveArcFractionFromActor,
  getCurveDataFromActor,
  getCurveHelixParamsFromActor,
  getCurveRadiusFromActor,
  getCurveSamplesPerSegmentFromActor,
  getCurveTypeFromActor
} from "@/features/curves/model";
import { estimateCurveLength } from "@/features/curves/sampler";
import { isAnalyticCurveKind } from "@/features/curves/types";

function formatRaycastLodSummary(actor: ActorNode, state: AppState): string {
  const targetIds = Array.isArray(actor.params.targetActorIds)
    ? (actor.params.targetActorIds as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  if (targetIds.length === 0) return "n/a";

  const formatOne = (targetId: string): string => {
    const target = state.actors[targetId];
    if (!target) return "missing";
    if (target.actorType !== "mesh") return "primitive";
    const originalId = typeof target.params.assetId === "string" ? target.params.assetId : "";
    const lodId = typeof target.params.viewportLodAssetId === "string" ? target.params.viewportLodAssetId : "";
    if (lodId) {
      const lod = state.assets.find((entry) => entry.id === lodId && entry.lodOf === originalId);
      if (lod) {
        const ratioPct = typeof lod.lodRatio === "number" ? `${Math.round(lod.lodRatio * 100)}%` : "?%";
        const tris = typeof lod.lodTriangleCount === "number" ? `${lod.lodTriangleCount.toLocaleString()} tris` : "";
        return tris ? `${ratioPct} (${tris})` : ratioPct;
      }
    }
    return "Original";
  };

  if (targetIds.length === 1) {
    return formatOne(targetIds[0] ?? "");
  }
  return `${formatOne(targetIds[0] ?? "")} (+${targetIds.length - 1} more)`;
}

interface CurveRuntime {
  curveType: "spline" | "circle" | "arc" | "helix" | "mesh-projection";
  closed: boolean;
  samplesPerSegment: number;
  pointCount: number;
  resolution: number;
  targetCount: number;
  radius?: number;
  arcFraction?: number;
  arcCentered?: boolean;
  helixPitch?: number;
  helixTurns?: number;
}

function resolveCurveType(value: unknown): CurveRuntime["curveType"] {
  if (value === "circle") return "circle";
  if (value === "arc") return "arc";
  if (value === "helix") return "helix";
  if (value === "mesh-projection") return "mesh-projection";
  return "spline";
}

function readArcFraction(params: { arcFraction?: unknown }, fallback = 1): number {
  const parsed = Number(params.arcFraction);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function readNumber(value: unknown, min: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

export const curveActorDescriptor: ReloadableDescriptor<CurveRuntime> = {
  id: "actor.curve",
  kind: "actor",
  version: 1,
  schema: CURVE_ACTOR_SCHEMA,
  spawn: {
    actorType: "curve",
    label: "Curve",
    description: "Editable spline or analytic circle curve actor.",
    iconGlyph: "CV",
    fileExtensions: []
  },
  createRuntime: ({ params }) => {
    const curveType = resolveCurveType(params.curveType);
    const targetCount = Array.isArray(params.targetActorIds)
      ? (params.targetActorIds as unknown[]).filter((entry) => typeof entry === "string").length
      : 0;
    const arcFraction = curveType === "arc" ? readArcFraction(params as { arcFraction?: unknown }, 1) : undefined;
    const arcCentered = curveType === "arc" ? Boolean((params as { arcCentered?: unknown }).arcCentered) : undefined;
    const closed = curveType === "arc"
      ? (arcFraction ?? 1) >= 1
      : curveType === "circle"
        ? true
        : curveType === "helix"
          ? false
          : Boolean(params.closed);
    return {
      curveType,
      closed,
      samplesPerSegment: Math.max(2, Math.floor(Number(params.samplesPerSegment ?? 24))),
      pointCount: curveType === "spline"
        ? Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
          ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? 0)
          : 0
        : 0,
      resolution: Math.max(3, Math.floor(Number(params.resolution ?? 64))),
      targetCount,
      radius: isAnalyticCurveKind(curveType)
        ? readNumber((params as { radius?: unknown }).radius, 0, 1)
        : undefined,
      arcFraction,
      arcCentered,
      helixPitch: curveType === "helix" ? readNumber((params as { helixPitch?: unknown }).helixPitch, 0, 1) : undefined,
      helixTurns: curveType === "helix" ? readNumber((params as { helixTurns?: unknown }).helixTurns, 0.01, 1) : undefined
    };
  },
  updateRuntime(runtime, { params }) {
    runtime.curveType = resolveCurveType(params.curveType);
    runtime.samplesPerSegment = Math.max(
      2,
      Math.floor(Number(params.samplesPerSegment ?? runtime.samplesPerSegment ?? 24))
    );
    runtime.pointCount = runtime.curveType === "spline"
      ? Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
        ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? runtime.pointCount)
        : runtime.pointCount
      : 0;
    runtime.resolution = Math.max(3, Math.floor(Number(params.resolution ?? runtime.resolution ?? 64)));
    runtime.targetCount = Array.isArray(params.targetActorIds)
      ? (params.targetActorIds as unknown[]).filter((entry) => typeof entry === "string").length
      : 0;
    if (isAnalyticCurveKind(runtime.curveType)) {
      runtime.radius = readNumber((params as { radius?: unknown }).radius, 0, runtime.radius ?? 1);
    } else {
      runtime.radius = undefined;
    }
    if (runtime.curveType === "arc") {
      runtime.arcFraction = readArcFraction(params as { arcFraction?: unknown }, runtime.arcFraction ?? 1);
      runtime.arcCentered = Boolean((params as { arcCentered?: unknown }).arcCentered);
    } else {
      runtime.arcFraction = undefined;
      runtime.arcCentered = undefined;
    }
    if (runtime.curveType === "helix") {
      runtime.helixPitch = readNumber((params as { helixPitch?: unknown }).helixPitch, 0, runtime.helixPitch ?? 1);
      runtime.helixTurns = readNumber((params as { helixTurns?: unknown }).helixTurns, 0.01, runtime.helixTurns ?? 1);
    } else {
      runtime.helixPitch = undefined;
      runtime.helixTurns = undefined;
    }
    runtime.closed = runtime.curveType === "arc"
      ? (runtime.arcFraction ?? 1) >= 1
      : runtime.curveType === "circle"
        ? true
        : runtime.curveType === "helix"
          ? false
          : Boolean(params.closed);
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const curve = curveDataWithOverrides(actor);
      const curveType = getCurveTypeFromActor(actor);
      const samplesPerSegment = getCurveSamplesPerSegmentFromActor(actor);
      const fallbackLength = estimateCurveLength(curve, samplesPerSegment);
      const autoCount = curve.points.filter((point) => point.mode === "auto").length;
      const mirroredCount = curve.points.filter((point) => point.mode === "mirrored").length;
      const hardCount = curve.points.filter((point) => point.mode === "hard").length;
      const normalCount = curve.points.length - autoCount - mirroredCount - hardCount;
      const defaultSegmentCount =
        isAnalyticCurveKind(curveType) ? 1
          : curveType === "mesh-projection" ? 0
          : curve.points.length < 2 ? 0
          : (curve.closed ? curve.points.length : curve.points.length - 1);

      const isAnalyticRadius = isAnalyticCurveKind(curveType);
      const baseRows: ActorStatusEntry[] = [
        { label: "Type", value: "Curve" },
        { label: "Curve Type", value: curveType },
        { label: "Closed", value: curve.closed },
        { label: "Radius (m)", value: isAnalyticRadius ? getCurveRadiusFromActor(actor) : "n/a" }
      ];

      const arcRows: ActorStatusEntry[] = curveType === "arc"
        ? [
            { label: "Arc Fraction", value: getCurveArcFractionFromActor(actor) },
            { label: "Centered", value: getCurveArcCenteredFromActor(actor) }
          ]
        : [];

      const helixRows: ActorStatusEntry[] = curveType === "helix"
        ? (() => {
            const { pitch, turns } = getCurveHelixParamsFromActor(actor);
            return [
              { label: "Pitch (m)", value: pitch },
              { label: "Turns", value: turns },
              { label: "Height (m)", value: pitch * turns }
            ] as ActorStatusEntry[];
          })()
        : [];

      const splineRows: ActorStatusEntry[] = curveType === "spline"
        ? [
            { label: "Points", value: runtimeStatus?.values.pointCount ?? getCurveDataFromActor(actor).points.length },
            { label: "Auto Points", value: autoCount },
            { label: "Mirrored Points", value: mirroredCount },
            { label: "Normal Points", value: normalCount },
            { label: "Hard Points", value: hardCount },
            { label: "Segments", value: runtimeStatus?.values.segmentCount ?? defaultSegmentCount },
            { label: "Samples / Segment", value: runtimeStatus?.values.samplesPerSegment ?? samplesPerSegment }
          ]
        : [];

      const projectionRows: ActorStatusEntry[] = curveType === "mesh-projection"
        ? [
            { label: "Resolution", value: runtimeStatus?.values.resolution ?? Math.max(3, Math.floor(Number(actor.params.resolution ?? 64))) },
            { label: "Hits", value: runtimeStatus?.values.projectedHitCount ?? 0 },
            { label: "Misses", value: runtimeStatus?.values.projectedMissCount ?? 0 },
            { label: "Targets", value: runtimeStatus?.values.targetCount ?? (Array.isArray(actor.params.targetActorIds) ? (actor.params.targetActorIds as unknown[]).length : 0) },
            { label: "Plane", value: runtimeStatus?.values.projectionPlane ?? (actor.params.projectionPlane ?? "XZ") },
            { label: "Raycast LOD", value: formatRaycastLodSummary(actor, state) },
            {
              label: "Cache State",
              value: typeof runtimeStatus?.values.cacheState === "string" ? runtimeStatus.values.cacheState : "n/a",
              tone: runtimeStatus?.values.cacheState === "stale" ? "warning" : undefined
            }
          ]
        : [];

      const trailingRows: ActorStatusEntry[] = [
        { label: "Approx Length (m)", value: runtimeStatus?.values.length ?? fallbackLength },
        { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];

      return [...baseRows, ...arcRows, ...helixRows, ...splineRows, ...projectionRows, ...trailingRows];
    }
  }
};

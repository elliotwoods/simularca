import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import type { ActorNode, AppState } from "@/core/types";
import { CURVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import { curveDataWithOverrides, getCurveDataFromActor, getCurveSamplesPerSegmentFromActor, getCurveTypeFromActor } from "@/features/curves/model";
import { estimateCurveLength } from "@/features/curves/sampler";

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
  curveType: "spline" | "circle" | "mesh-projection";
  closed: boolean;
  samplesPerSegment: number;
  pointCount: number;
  resolution: number;
  targetCount: number;
}

function resolveCurveType(value: unknown): CurveRuntime["curveType"] {
  if (value === "circle") return "circle";
  if (value === "mesh-projection") return "mesh-projection";
  return "spline";
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
    return {
      curveType,
      closed: Boolean(params.closed),
      samplesPerSegment: Math.max(2, Math.floor(Number(params.samplesPerSegment ?? 24))),
      pointCount: curveType === "spline"
        ? Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
          ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? 0)
          : 0
        : 0,
      resolution: Math.max(3, Math.floor(Number(params.resolution ?? 64))),
      targetCount
    };
  },
  updateRuntime(runtime, { params }) {
    runtime.curveType = resolveCurveType(params.curveType);
    runtime.closed = Boolean(params.closed);
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
        curveType === "circle" ? 1
          : curveType === "mesh-projection" ? 0
          : curve.points.length < 2 ? 0
          : (curve.closed ? curve.points.length : curve.points.length - 1);

      const baseRows: ActorStatusEntry[] = [
        { label: "Type", value: "Curve" },
        { label: "Curve Type", value: curveType },
        { label: "Closed", value: curveType === "circle" || curveType === "mesh-projection" ? true : curve.closed },
        { label: "Radius (m)", value: curveType === "circle" ? curve.radius ?? 1 : "n/a" }
      ];

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

      return [...baseRows, ...splineRows, ...projectionRows, ...trailingRows];
    }
  }
};

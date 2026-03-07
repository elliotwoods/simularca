import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { CURVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import { curveDataWithOverrides, getCurveDataFromActor, getCurveSamplesPerSegmentFromActor, getCurveTypeFromActor } from "@/features/curves/model";
import { estimateCurveLength } from "@/features/curves/sampler";

interface CurveRuntime {
  curveType: "spline" | "circle";
  closed: boolean;
  samplesPerSegment: number;
  pointCount: number;
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
  createRuntime: ({ params }) => ({
    curveType: params.curveType === "circle" ? "circle" : "spline",
    closed: Boolean(params.closed),
    samplesPerSegment: Math.max(2, Math.floor(Number(params.samplesPerSegment ?? 24))),
    pointCount: params.curveType === "circle"
      ? 0
      : Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
      ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? 0)
      : 0
  }),
  updateRuntime(runtime, { params }) {
    runtime.curveType = params.curveType === "circle" ? "circle" : "spline";
    runtime.closed = Boolean(params.closed);
    runtime.samplesPerSegment = Math.max(
      2,
      Math.floor(Number(params.samplesPerSegment ?? runtime.samplesPerSegment ?? 24))
    );
    runtime.pointCount = runtime.curveType === "circle"
      ? 0
      : Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
      ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? runtime.pointCount)
      : runtime.pointCount;
  },
  status: {
    build({ actor, runtimeStatus }) {
      const curve = curveDataWithOverrides(actor);
      const curveType = getCurveTypeFromActor(actor);
      const samplesPerSegment = getCurveSamplesPerSegmentFromActor(actor);
      const fallbackLength = estimateCurveLength(curve, samplesPerSegment);
      const autoCount = curve.points.filter((point) => point.mode === "auto").length;
      const mirroredCount = curve.points.filter((point) => point.mode === "mirrored").length;
      const hardCount = curve.points.filter((point) => point.mode === "hard").length;
      const normalCount = curve.points.length - autoCount - mirroredCount - hardCount;
      const defaultSegmentCount =
        curveType === "circle" ? 1 : curve.points.length < 2 ? 0 : (curve.closed ? curve.points.length : curve.points.length - 1);
      return [
        { label: "Type", value: "Curve" },
        { label: "Curve Type", value: curveType },
        { label: "Closed", value: curveType === "circle" ? true : curve.closed },
        { label: "Radius (m)", value: curveType === "circle" ? curve.radius ?? 1 : "n/a" },
        { label: "Points", value: runtimeStatus?.values.pointCount ?? getCurveDataFromActor(actor).points.length },
        { label: "Auto Points", value: autoCount },
        { label: "Mirrored Points", value: mirroredCount },
        { label: "Normal Points", value: normalCount },
        { label: "Hard Points", value: hardCount },
        { label: "Segments", value: runtimeStatus?.values.segmentCount ?? defaultSegmentCount },
        { label: "Samples / Segment", value: runtimeStatus?.values.samplesPerSegment ?? samplesPerSegment },
        { label: "Approx Length (m)", value: runtimeStatus?.values.length ?? fallbackLength },
        { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

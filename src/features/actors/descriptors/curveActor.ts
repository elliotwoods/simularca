import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { CURVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import { curveDataWithOverrides, getCurveDataFromActor, getCurveSamplesPerSegmentFromActor } from "@/features/curves/model";
import { estimateCurveLength } from "@/features/curves/sampler";

interface CurveRuntime {
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
    description: "Editable cubic Bezier spline actor.",
    iconGlyph: "CV",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    closed: Boolean(params.closed),
    samplesPerSegment: Math.max(2, Math.floor(Number(params.samplesPerSegment ?? 24))),
    pointCount: Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
      ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? 0)
      : 0
  }),
  updateRuntime(runtime, { params }) {
    runtime.closed = Boolean(params.closed);
    runtime.samplesPerSegment = Math.max(
      2,
      Math.floor(Number(params.samplesPerSegment ?? runtime.samplesPerSegment ?? 24))
    );
    runtime.pointCount = Array.isArray((params as { curveData?: { points?: unknown[] } }).curveData?.points)
      ? ((params as { curveData?: { points?: unknown[] } }).curveData?.points?.length ?? runtime.pointCount)
      : runtime.pointCount;
  },
  status: {
    build({ actor, runtimeStatus }) {
      const curve = curveDataWithOverrides(actor);
      const samplesPerSegment = getCurveSamplesPerSegmentFromActor(actor);
      const fallbackLength = estimateCurveLength(curve, samplesPerSegment);
      const defaultSegmentCount = curve.points.length < 2 ? 0 : (curve.closed ? curve.points.length : curve.points.length - 1);
      return [
        { label: "Type", value: "Curve" },
        { label: "Closed", value: curve.closed },
        { label: "Points", value: runtimeStatus?.values.pointCount ?? getCurveDataFromActor(actor).points.length },
        { label: "Segments", value: runtimeStatus?.values.segmentCount ?? defaultSegmentCount },
        { label: "Samples / Segment", value: runtimeStatus?.values.samplesPerSegment ?? samplesPerSegment },
        { label: "Approx Length", value: runtimeStatus?.values.length ?? fallbackLength },
        { label: "Bounds Min", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

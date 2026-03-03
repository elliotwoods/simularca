import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { GAUSSIAN_SPLAT_SPARK_SCHEMA } from "@/features/actors/actorTypes";

interface GaussianSplatSparkRuntime {
  assetId?: string;
  scaleFactor: number;
  opacity: number;
}

export const gaussianSplatSparkActorDescriptor: ReloadableDescriptor<GaussianSplatSparkRuntime> = {
  id: "actor.gaussianSplatSpark",
  kind: "actor",
  version: 1,
  schema: GAUSSIAN_SPLAT_SPARK_SCHEMA,
  spawn: {
    actorType: "gaussian-splat-spark",
    label: "Gaussian Splat (Spark)",
    description: "Renders imported PLY Gaussian splats using Spark/WebGL.",
    iconGlyph: "GS",
    fileExtensions: [".ply"]
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1,
    opacity: typeof params.opacity === "number" ? params.opacity : 1
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
    runtime.opacity = typeof params.opacity === "number" ? params.opacity : runtime.opacity;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      return [
        { label: "Type", value: "Gaussian Splat (Spark)" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        {
          label: "Scale",
          value: typeof actor.params.scaleFactor === "number" ? actor.params.scaleFactor : 1
        },
        {
          label: "Opacity",
          value: typeof actor.params.opacity === "number" ? actor.params.opacity : 1
        },
        { label: "Backend", value: runtimeStatus?.values.backend ?? "n/a" },
        { label: "Load State", value: runtimeStatus?.values.loadState ?? "n/a" },
        { label: "Point Count", value: runtimeStatus?.values.pointCount ?? "n/a" },
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

import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { GAUSSIAN_SPLAT_SCHEMA } from "@/features/actors/actorTypes";

interface GaussianSplatRuntime {
  assetId?: string;
  scaleFactor: number;
  opacity: number;
  pointSize: number;
}

export const gaussianSplatActorDescriptor: ReloadableDescriptor<GaussianSplatRuntime> = {
  id: "actor.gaussianSplat",
  kind: "actor",
  version: 1,
  schema: GAUSSIAN_SPLAT_SCHEMA,
  spawn: {
    actorType: "gaussian-splat",
    label: "Gaussian Splat",
    description: "Renders imported splat point-cloud assets.",
    iconGlyph: "GS",
    fileExtensions: [".ply"]
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1,
    opacity: typeof params.opacity === "number" ? params.opacity : 1,
    pointSize: typeof params.pointSize === "number" ? params.pointSize : 0.02
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
    runtime.opacity = typeof params.opacity === "number" ? params.opacity : runtime.opacity;
    runtime.pointSize = typeof params.pointSize === "number" ? params.pointSize : runtime.pointSize;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      return [
        { label: "Type", value: "Gaussian Splat" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        {
          label: "Scale Factor",
          value: typeof actor.params.scaleFactor === "number" ? actor.params.scaleFactor : 1
        },
        {
          label: "Opacity",
          value: typeof actor.params.opacity === "number" ? actor.params.opacity : 1
        },
        {
          label: "Point Size",
          value: typeof actor.params.pointSize === "number" ? actor.params.pointSize : 0.02
        },
        { label: "Backend", value: runtimeStatus?.values.backend ?? "n/a" },
        { label: "Loader", value: runtimeStatus?.values.loader ?? "n/a" },
        { label: "Loader Version", value: runtimeStatus?.values.loaderVersion ?? "n/a" },
        { label: "Point Count", value: runtimeStatus?.values.pointCount ?? "n/a" },
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

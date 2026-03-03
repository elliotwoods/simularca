import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { GAUSSIAN_SPLAT_SCHEMA } from "@/features/actors/actorTypes";

interface GaussianSplatRuntime {
  assetId?: string;
  scaleFactor: number;
  splatSize: number;
  opacity: number;
  filterMode: "off" | "inside" | "outside";
  filterRegionActorIds: string[];
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
    splatSize: typeof params.splatSize === "number" ? params.splatSize : 1,
    opacity: typeof params.opacity === "number" ? params.opacity : 1,
    filterMode:
      params.filterMode === "inside" || params.filterMode === "outside" ? params.filterMode : "off",
    filterRegionActorIds: Array.isArray(params.filterRegionActorIds)
      ? params.filterRegionActorIds.filter((entry): entry is string => typeof entry === "string")
      : []
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
    runtime.splatSize = typeof params.splatSize === "number" ? params.splatSize : runtime.splatSize;
    runtime.opacity = typeof params.opacity === "number" ? params.opacity : runtime.opacity;
    runtime.filterMode =
      params.filterMode === "inside" || params.filterMode === "outside" ? params.filterMode : "off";
    runtime.filterRegionActorIds = Array.isArray(params.filterRegionActorIds)
      ? params.filterRegionActorIds.filter((entry): entry is string => typeof entry === "string")
      : runtime.filterRegionActorIds;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const formatRange = (value: unknown): string => {
        if (!value || typeof value !== "object") {
          return "n/a";
        }
        const maybe = value as { min?: unknown; max?: unknown };
        const min = typeof maybe.min === "number" ? maybe.min : null;
        const max = typeof maybe.max === "number" ? maybe.max : null;
        if (min === null || max === null) {
          return "n/a";
        }
        return `${min.toFixed(4)} .. ${max.toFixed(4)}`;
      };
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      const filterMode =
        actor.params.filterMode === "inside" || actor.params.filterMode === "outside" ? actor.params.filterMode : "off";
      const filterRegionIds = Array.isArray(actor.params.filterRegionActorIds)
        ? actor.params.filterRegionActorIds.filter((entry): entry is string => typeof entry === "string")
        : [];
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
          label: "Splat Size",
          value: typeof actor.params.splatSize === "number" ? actor.params.splatSize : 1
        },
        { label: "Filter Mode", value: filterMode },
        { label: "Filter Regions", value: filterRegionIds.length },
        { label: "Backend", value: runtimeStatus?.values.backend ?? "n/a" },
        { label: "Loader", value: runtimeStatus?.values.loader ?? "n/a" },
        { label: "Encoding", value: runtimeStatus?.values.encoding ?? "n/a" },
        { label: "Loader Version", value: runtimeStatus?.values.loaderVersion ?? "n/a" },
        { label: "Color Source", value: runtimeStatus?.values.colorSource ?? "n/a" },
        { label: "Color Spread", value: runtimeStatus?.values.colorSpread ?? "n/a" },
        { label: "Color Denominator", value: runtimeStatus?.values.colorDenominator ?? "n/a" },
        { label: "Average Color", value: runtimeStatus?.values.averageColor ?? "n/a" },
        { label: "Attributes", value: runtimeStatus?.values.attributes ?? "n/a" },
        { label: "Has SH DC", value: runtimeStatus?.values.hasFdc ?? "n/a" },
        { label: "Has Scale", value: runtimeStatus?.values.hasScale ?? "n/a" },
        { label: "Has Rotation", value: runtimeStatus?.values.hasRotation ?? "n/a" },
        { label: "Has Opacity", value: runtimeStatus?.values.hasOpacity ?? "n/a" },
        { label: "Scale0 Range", value: formatRange(runtimeStatus?.values.scale0Range) },
        { label: "Scale1 Range", value: formatRange(runtimeStatus?.values.scale1Range) },
        { label: "Scale2 Range", value: formatRange(runtimeStatus?.values.scale2Range) },
        { label: "Opacity Range", value: formatRange(runtimeStatus?.values.opacityRange) },
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

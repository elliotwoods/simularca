import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { GAUSSIAN_SPLAT_SPARK_SCHEMA } from "@/features/actors/actorTypes";

interface GaussianSplatSparkRuntime {
  assetId?: string;
  scaleFactor: number;
  opacity: number;
  brightness: number;
  colorInputSpace: string;
  stochasticDepth: boolean;
}

export const gaussianSplatSparkActorDescriptor: ReloadableDescriptor<GaussianSplatSparkRuntime> = {
  id: "actor.gaussianSplatSpark",
  kind: "actor",
  version: 1,
  schema: GAUSSIAN_SPLAT_SPARK_SCHEMA,
  spawn: {
    actorType: "gaussian-splat-spark",
    label: "Gaussian Splat",
    description: "Renders imported PLY Gaussian splats using the Spark/WebGL pipeline.",
    iconGlyph: "GS",
    fileExtensions: [".ply"]
  },
    createRuntime: ({ params }) => ({
      assetId: typeof params.assetId === "string" ? params.assetId : undefined,
      scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1,
      opacity: typeof params.opacity === "number" ? params.opacity : 1,
    brightness: typeof params.brightness === "number" ? params.brightness : 1,
    colorInputSpace: typeof params.colorInputSpace === "string" ? params.colorInputSpace : "srgb",
    stochasticDepth: params.stochasticDepth === true
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
    runtime.opacity = typeof params.opacity === "number" ? params.opacity : runtime.opacity;
    runtime.brightness = typeof params.brightness === "number" ? params.brightness : runtime.brightness;
    runtime.colorInputSpace = typeof params.colorInputSpace === "string" ? params.colorInputSpace : runtime.colorInputSpace;
    runtime.stochasticDepth = params.stochasticDepth === true;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      return [
        { label: "Type", value: "Gaussian Splat" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        {
          label: "Scale",
          value: typeof actor.params.scaleFactor === "number" ? actor.params.scaleFactor : 1
        },
        {
          label: "Opacity",
          value: typeof actor.params.opacity === "number" ? actor.params.opacity : 1
        },
        {
          label: "Brightness",
          value: typeof actor.params.brightness === "number" ? actor.params.brightness : 1
        },
      {
        label: "Splat Output Transform",
        value: typeof actor.params.colorInputSpace === "string" ? actor.params.colorInputSpace : "srgb"
      },
      {
        label: "Depth-Correct Transparency",
        value: typeof actor.params.stochasticDepth === "boolean" ? actor.params.stochasticDepth : false
      },
      { label: "Backend", value: runtimeStatus?.values.backend ?? "n/a" },
      {
        label: "Transparency Mode",
        value: runtimeStatus?.values.transparencyMode ?? ((actor.params.stochasticDepth === true) ? "stochastic-depth" : "alpha-blended")
      },
      { label: "Load State", value: runtimeStatus?.values.loadState ?? "n/a" },
      { label: "Point Count", value: runtimeStatus?.values.pointCount ?? "n/a" },
      { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
      { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
      ...(typeof runtimeStatus?.values.warning === "string"
        ? [{ label: "Warning", value: runtimeStatus.values.warning, tone: "warning" as const }]
        : []),
      {
        label: "Last Update",
        value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
      },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

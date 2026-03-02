import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { GAUSSIAN_SPLAT_SCHEMA } from "@/features/actors/actorTypes";

interface GaussianSplatRuntime {
  assetId?: string;
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
    iconGlyph: "GS"
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    opacity: typeof params.opacity === "number" ? params.opacity : 1,
    pointSize: typeof params.pointSize === "number" ? params.pointSize : 0.02
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.opacity = typeof params.opacity === "number" ? params.opacity : runtime.opacity;
    runtime.pointSize = typeof params.pointSize === "number" ? params.pointSize : runtime.pointSize;
  }
};


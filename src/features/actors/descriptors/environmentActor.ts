import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { ENVIRONMENT_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface EnvironmentRuntime {
  assetId?: string;
  intensity: number;
}

export const environmentActorDescriptor: ReloadableDescriptor<EnvironmentRuntime> = {
  id: "actor.environment",
  kind: "actor",
  version: 1,
  schema: ENVIRONMENT_ACTOR_SCHEMA,
  spawn: {
    actorType: "environment",
    label: "Environment",
    description: "Assigns HDRI lighting and scene background.",
    iconGlyph: "ENV"
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    intensity: typeof params.intensity === "number" ? params.intensity : 1
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.intensity = typeof params.intensity === "number" ? params.intensity : runtime.intensity;
  }
};


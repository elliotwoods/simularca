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
    iconGlyph: "ENV",
    fileExtensions: [".hdr", ".exr", ".ktx2", ".png", ".jpg", ".jpeg"]
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    intensity: typeof params.intensity === "number" ? params.intensity : 1
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.intensity = typeof params.intensity === "number" ? params.intensity : runtime.intensity;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      return [
        { label: "Type", value: "Environment" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        {
          label: "Intensity",
          value: typeof actor.params.intensity === "number" ? actor.params.intensity : 1
        },
        { label: "Format", value: runtimeStatus?.values.format ?? "n/a" },
        { label: "Load State", value: runtimeStatus?.values.loadState ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

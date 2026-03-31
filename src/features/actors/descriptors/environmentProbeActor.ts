import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { ENVIRONMENT_PROBE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface EnvironmentProbeRuntime {
  actorIds: string[];
  resolution: number;
  preview: "cube" | "sphere";
  renderMode: "never" | "on-change" | "always";
}

function readPreview(value: unknown): EnvironmentProbeRuntime["preview"] {
  return value === "cube" ? value : "sphere";
}

function readRenderMode(value: unknown): EnvironmentProbeRuntime["renderMode"] {
  return value === "never" || value === "always" ? value : "on-change";
}

export const environmentProbeActorDescriptor: ReloadableDescriptor<EnvironmentProbeRuntime> = {
  id: "actor.environmentProbe",
  kind: "actor",
  version: 1,
  schema: ENVIRONMENT_PROBE_ACTOR_SCHEMA,
  spawn: {
    actorType: "environment-probe",
    label: "Environment Probe",
    description: "Captures a cubemap and exposes it as a local reflection source.",
    iconGlyph: "PRB",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    actorIds: Array.isArray(params.actorIds) ? params.actorIds.filter((entry): entry is string => typeof entry === "string") : [],
    resolution: typeof params.resolution === "number" ? params.resolution : 256,
    preview: readPreview(params.preview),
    renderMode: readRenderMode(params.renderMode)
  }),
  updateRuntime(runtime, { params }) {
    runtime.actorIds = Array.isArray(params.actorIds) ? params.actorIds.filter((entry): entry is string => typeof entry === "string") : runtime.actorIds;
    runtime.resolution = typeof params.resolution === "number" ? params.resolution : runtime.resolution;
    runtime.preview = readPreview(params.preview);
    runtime.renderMode = readRenderMode(params.renderMode);
  },
  status: {
    build({ actor, runtimeStatus }) {
      const selectedActors = Array.isArray(actor.params.actorIds)
        ? actor.params.actorIds.filter((entry): entry is string => typeof entry === "string")
        : [];
      const capturedActors =
        typeof runtimeStatus?.values.capturedActorCount === "number"
          ? runtimeStatus.values.capturedActorCount
          : selectedActors.length;
      return [
        { label: "Type", value: "Environment Probe" },
        { label: "Captured Actors", value: capturedActors },
        { label: "Selected Actors", value: selectedActors.length },
        { label: "Skipped Actors", value: runtimeStatus?.values.skippedActorCount ?? 0 },
        { label: "Face Resolution", value: typeof actor.params.resolution === "number" ? actor.params.resolution : 256 },
        { label: "Preview", value: readPreview(actor.params.preview) },
        { label: "Render Mode", value: readRenderMode(actor.params.renderMode) },
        { label: "Load State", value: runtimeStatus?.values.loadState ?? "idle" },
        { label: "Last Reason", value: runtimeStatus?.values.lastRenderReason ?? "n/a" },
        { label: "Background", value: runtimeStatus?.values.backgroundSourceName ?? "none" },
        ...(typeof runtimeStatus?.values.warning === "string"
          ? [{ label: "Warning", value: runtimeStatus.values.warning, tone: "warning" as const }]
          : []),
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

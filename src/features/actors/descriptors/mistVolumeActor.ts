import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { MIST_VOLUME_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface MistVolumeRuntime {
  volumeActorId: string | null;
  sourceActorIds: string[];
  resolutionX: number;
  resolutionY: number;
  resolutionZ: number;
  renderOverrideEnabled: boolean;
}

function parseActorIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const mistVolumeActorDescriptor: ReloadableDescriptor<MistVolumeRuntime> = {
  id: "actor.mistVolume",
  kind: "actor",
  version: 1,
  schema: MIST_VOLUME_ACTOR_SCHEMA,
  spawn: {
    actorType: "mist-volume",
    label: "Mist Volume",
    description: "Realtime cuboid mist simulation and preview volume.",
    iconGlyph: "MV"
  },
  createRuntime: ({ params }) => ({
    volumeActorId: typeof params.volumeActorId === "string" && params.volumeActorId.length > 0 ? params.volumeActorId : null,
    sourceActorIds: parseActorIdList(params.sourceActorIds),
    resolutionX: readNumber(params.resolutionX, 32),
    resolutionY: readNumber(params.resolutionY, 24),
    resolutionZ: readNumber(params.resolutionZ, 32),
    renderOverrideEnabled: params.renderOverrideEnabled === true
  }),
  updateRuntime(runtime, { params }) {
    runtime.volumeActorId = typeof params.volumeActorId === "string" && params.volumeActorId.length > 0 ? params.volumeActorId : null;
    runtime.sourceActorIds = parseActorIdList(params.sourceActorIds);
    runtime.resolutionX = readNumber(params.resolutionX, runtime.resolutionX);
    runtime.resolutionY = readNumber(params.resolutionY, runtime.resolutionY);
    runtime.resolutionZ = readNumber(params.resolutionZ, runtime.resolutionZ);
    runtime.renderOverrideEnabled = params.renderOverrideEnabled === true;
  },
  status: {
    build({ actor, runtimeStatus }) {
      return [
        { label: "Type", value: "Mist Volume" },
        {
          label: "Volume Cube",
          value: runtimeStatus?.values.volumeActorName ?? (typeof actor.params.volumeActorId === "string" && actor.params.volumeActorId.length > 0 ? actor.params.volumeActorId : "n/a")
        },
        { label: "Emitter Sources", value: Array.isArray(actor.params.sourceActorIds) ? actor.params.sourceActorIds.length : 0 },
        {
          label: "Preview Resolution",
          value: runtimeStatus?.values.previewResolution ?? [
            readNumber(actor.params.resolutionX, 32),
            readNumber(actor.params.resolutionY, 24),
            readNumber(actor.params.resolutionZ, 32)
          ]
        },
        {
          label: "Render Override",
          value: actor.params.renderOverrideEnabled === true
        },
        {
          label: "Preview Mode",
          value: runtimeStatus?.values.previewMode ?? (typeof actor.params.previewMode === "string" ? actor.params.previewMode : "volume")
        },
        {
          label: "Effective Quality",
          value: runtimeStatus?.values.qualityMode ?? "interactive"
        },
        {
          label: "Active Sources",
          value: runtimeStatus?.values.activeSourceCount ?? 0
        },
        {
          label: "Density Range",
          value: runtimeStatus?.values.densityRange ?? "n/a"
        },
        {
          label: "Preview Visible",
          value: runtimeStatus?.values.previewVisible ?? false
        },
        {
          label: "Noise Seed",
          value: runtimeStatus?.values.noiseSeed ?? readNumber(actor.params.noiseSeed, 1)
        },
        {
          label: "Emission Noise",
          value: runtimeStatus?.values.emissionNoiseActive ?? (readNumber(actor.params.emissionNoiseStrength, 0) > 0)
        },
        {
          label: "Wind Noise",
          value: runtimeStatus?.values.windNoiseActive ?? (readNumber(actor.params.windNoiseStrength, 0) > 0)
        },
        {
          label: "Wispiness",
          value: runtimeStatus?.values.wispiness ?? readNumber(actor.params.wispiness, 0)
        },
        {
          label: "Edge Breakup",
          value: runtimeStatus?.values.edgeBreakup ?? readNumber(actor.params.edgeBreakup, 0)
        },
        {
          label: "Source Collect Ms",
          value: runtimeStatus?.values.sourceCollectMs ?? "n/a"
        },
        {
          label: "Simulate Ms",
          value: runtimeStatus?.values.simulationMs ?? "n/a"
        },
        {
          label: "Upload Ms",
          value: runtimeStatus?.values.uploadMs ?? "n/a"
        },
        {
          label: "Total Update Ms",
          value: runtimeStatus?.values.totalUpdateMs ?? "n/a"
        },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

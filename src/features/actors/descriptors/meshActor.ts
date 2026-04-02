import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { MESH_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface MeshRuntime {
  assetId?: string;
  scaleFactor: number;
  animationEnabled: boolean;
  animationClipName?: string;
  animationSpeed: number;
  animationLoop: boolean;
  animationStartOffsetSeconds: number;
}

export const meshActorDescriptor: ReloadableDescriptor<MeshRuntime> = {
  id: "actor.mesh",
  kind: "actor",
  version: 1,
  schema: MESH_ACTOR_SCHEMA,
  spawn: {
    actorType: "mesh",
    label: "Mesh",
    description: "Renders imported mesh files (GLB/GLTF/FBX/DAE/OBJ).",
    iconGlyph: "MESH",
    fileExtensions: [".glb", ".gltf", ".fbx", ".dae", ".obj"]
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1,
    animationEnabled: Boolean(params.animationEnabled),
    animationClipName: typeof params.animationClipName === "string" ? params.animationClipName : undefined,
    animationSpeed: typeof params.animationSpeed === "number" ? params.animationSpeed : 1,
    animationLoop: params.animationLoop !== false,
    animationStartOffsetSeconds: typeof params.animationStartOffsetSeconds === "number" ? params.animationStartOffsetSeconds : 0
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
    runtime.animationEnabled = Boolean(params.animationEnabled);
    runtime.animationClipName = typeof params.animationClipName === "string" ? params.animationClipName : runtime.animationClipName;
    runtime.animationSpeed = typeof params.animationSpeed === "number" ? params.animationSpeed : runtime.animationSpeed;
    runtime.animationLoop = params.animationLoop !== false;
    runtime.animationStartOffsetSeconds =
      typeof params.animationStartOffsetSeconds === "number"
        ? params.animationStartOffsetSeconds
        : runtime.animationStartOffsetSeconds;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      return [
        { label: "Type", value: "Mesh" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        {
          label: "Import Scale (src->m)",
          value: typeof actor.params.scaleFactor === "number" ? actor.params.scaleFactor : 1
        },
        { label: "Animation Enabled", value: Boolean(actor.params.animationEnabled) },
        { label: "Format", value: runtimeStatus?.values.format ?? "n/a" },
        { label: "Load State", value: runtimeStatus?.values.loadState ?? "n/a" },
        { label: "Meshes", value: runtimeStatus?.values.meshCount ?? "n/a" },
        { label: "Triangles", value: runtimeStatus?.values.triangleCount ?? "n/a" },
        { label: "Animation State", value: runtimeStatus?.values.animationState ?? "n/a" },
        { label: "Animation Clip", value: runtimeStatus?.values.animationClip ?? "n/a" },
        { label: "Animation Clips", value: runtimeStatus?.values.animationClipCount ?? "n/a" },
        { label: "Animation Duration (s)", value: runtimeStatus?.values.animationDurationSeconds ?? "n/a" },
        { label: "Animation Time (s)", value: runtimeStatus?.values.animationTimeSeconds ?? "n/a" },
        { label: "Skinned Meshes", value: runtimeStatus?.values.skinnedMeshCount ?? "n/a" },
        { label: "Morph Target Meshes", value: runtimeStatus?.values.morphTargetMeshCount ?? "n/a" },
        { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        { label: "Size (m)", value: runtimeStatus?.values.size ?? "n/a" },
        {
          label: "Material Slots",
          value: runtimeStatus?.values.materialSlotNames
            ? (runtimeStatus.values.materialSlotNames as string[]).join(", ")
            : "n/a"
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

import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { MESH_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface MeshRuntime {
  assetId?: string;
  scaleFactor: number;
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
    scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : runtime.scaleFactor;
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
        { label: "Format", value: runtimeStatus?.values.format ?? "n/a" },
        { label: "Meshes", value: runtimeStatus?.values.meshCount ?? "n/a" },
        { label: "Triangles", value: runtimeStatus?.values.triangleCount ?? "n/a" },
        { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        { label: "Size (m)", value: runtimeStatus?.values.size ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

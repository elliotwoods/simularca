import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { PRIMITIVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface PrimitiveRuntime {
  shape: string;
  size: number;
  segments: number;
  color: string;
  wireframe: boolean;
}

export const primitiveActorDescriptor: ReloadableDescriptor<PrimitiveRuntime> = {
  id: "actor.primitive",
  kind: "actor",
  version: 1,
  schema: PRIMITIVE_ACTOR_SCHEMA,
  spawn: {
    actorType: "primitive",
    label: "Primitive",
    description: "Simple analytic mesh actor (cube/sphere/torus/etc).",
    iconGlyph: "PRM",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    shape: typeof params.shape === "string" ? params.shape : "cube",
    size: typeof params.size === "number" ? params.size : 1,
    segments: typeof params.segments === "number" ? params.segments : 24,
    color: typeof params.color === "string" ? params.color : "#4fb3ff",
    wireframe: typeof params.wireframe === "boolean" ? params.wireframe : false
  }),
  updateRuntime(runtime, { params }) {
    runtime.shape = typeof params.shape === "string" ? params.shape : runtime.shape;
    runtime.size = typeof params.size === "number" ? params.size : runtime.size;
    runtime.segments = typeof params.segments === "number" ? params.segments : runtime.segments;
    runtime.color = typeof params.color === "string" ? params.color : runtime.color;
    runtime.wireframe = typeof params.wireframe === "boolean" ? params.wireframe : runtime.wireframe;
  },
  status: {
    build({ actor }) {
      return [
        { label: "Type", value: "Primitive" },
        { label: "Shape", value: typeof actor.params.shape === "string" ? actor.params.shape : "cube" },
        { label: "Size", value: typeof actor.params.size === "number" ? actor.params.size : 1 },
        { label: "Segments", value: typeof actor.params.segments === "number" ? actor.params.segments : 24 },
        { label: "Color", value: typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff" },
        { label: "Wireframe", value: Boolean(actor.params.wireframe) }
      ];
    }
  }
};

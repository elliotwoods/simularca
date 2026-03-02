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
    iconGlyph: "PRM"
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
  }
};

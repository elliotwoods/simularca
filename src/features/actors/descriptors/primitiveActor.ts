import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { PRIMITIVE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface PrimitiveRuntime {
  shape: string;
  cubeSize: number;
  sphereRadius: number;
  cylinderRadius: number;
  cylinderHeight: number;
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
    description: "Simple analytic mesh actor (cube/sphere/cylinder).",
    iconGlyph: "PRM",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    shape: typeof params.shape === "string" ? params.shape : "cube",
    cubeSize: typeof params.cubeSize === "number" ? params.cubeSize : 1,
    sphereRadius: typeof params.sphereRadius === "number" ? params.sphereRadius : 0.5,
    cylinderRadius: typeof params.cylinderRadius === "number" ? params.cylinderRadius : 0.5,
    cylinderHeight: typeof params.cylinderHeight === "number" ? params.cylinderHeight : 1,
    segments: typeof params.segments === "number" ? params.segments : 24,
    color: typeof params.color === "string" ? params.color : "#4fb3ff",
    wireframe: typeof params.wireframe === "boolean" ? params.wireframe : false
  }),
  updateRuntime(runtime, { params }) {
    runtime.shape = typeof params.shape === "string" ? params.shape : runtime.shape;
    runtime.cubeSize = typeof params.cubeSize === "number" ? params.cubeSize : runtime.cubeSize;
    runtime.sphereRadius = typeof params.sphereRadius === "number" ? params.sphereRadius : runtime.sphereRadius;
    runtime.cylinderRadius = typeof params.cylinderRadius === "number" ? params.cylinderRadius : runtime.cylinderRadius;
    runtime.cylinderHeight = typeof params.cylinderHeight === "number" ? params.cylinderHeight : runtime.cylinderHeight;
    runtime.segments = typeof params.segments === "number" ? params.segments : runtime.segments;
    runtime.color = typeof params.color === "string" ? params.color : runtime.color;
    runtime.wireframe = typeof params.wireframe === "boolean" ? params.wireframe : runtime.wireframe;
  },
  status: {
    build({ actor }) {
      const shape = typeof actor.params.shape === "string" ? actor.params.shape : "cube";
      const rows: Array<{ label: string; value: string | number | boolean }> = [
        { label: "Type", value: "Primitive" },
        { label: "Shape", value: shape }
      ];
      if (shape === "sphere") {
        rows.push(
          {
            label: "Sphere Radius (m)",
            value: typeof actor.params.sphereRadius === "number" ? actor.params.sphereRadius : 0.5
          },
          { label: "Segments", value: typeof actor.params.segments === "number" ? actor.params.segments : 24 }
        );
      } else if (shape === "cylinder") {
        rows.push(
          {
            label: "Cylinder Radius (m)",
            value: typeof actor.params.cylinderRadius === "number" ? actor.params.cylinderRadius : 0.5
          },
          {
            label: "Cylinder Height (m)",
            value: typeof actor.params.cylinderHeight === "number" ? actor.params.cylinderHeight : 1
          },
          { label: "Segments", value: typeof actor.params.segments === "number" ? actor.params.segments : 24 }
        );
      } else {
        rows.push({ label: "Cube Size (m)", value: typeof actor.params.cubeSize === "number" ? actor.params.cubeSize : 1 });
      }
      return [
        ...rows,
        { label: "Color", value: typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff" },
        { label: "Wireframe", value: Boolean(actor.params.wireframe) }
      ];
    }
  }
};

import { z } from "zod";
import { SESSION_SCHEMA_VERSION } from "@/core/types";
import type { SessionManifest } from "@/core/types";

const vector3Schema = z.tuple([z.number(), z.number(), z.number()]);

const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.literal("actor"),
  actorType: z.enum(["empty", "environment", "gaussian-splat", "primitive", "plugin"]),
  pluginType: z.string().optional(),
  parentActorId: z.string().nullable(),
  childActorIds: z.array(z.string()),
  componentIds: z.array(z.string()),
  transform: z.object({
    position: vector3Schema,
    rotation: vector3Schema,
    scale: vector3Schema
  }),
  params: z.record(z.union([z.number(), z.string(), z.boolean()]))
});

const componentSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.literal("component"),
  parentActorId: z.string().nullable(),
  componentType: z.string(),
  schemaId: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()]))
});

const sessionSchema = z.object({
  schemaVersion: z.number(),
  appMode: z.enum(["electron-rw", "web-ro"]),
  sessionName: z.string(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
  scene: z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    kind: z.literal("scene"),
    actorIds: z.array(z.string()),
    sceneComponentIds: z.array(z.string())
  }),
  actors: z.record(actorSchema),
  components: z.record(componentSchema),
  camera: z.object({
    mode: z.enum(["perspective", "orthographic"]),
    position: vector3Schema,
    target: vector3Schema,
    fov: z.number(),
    zoom: z.number(),
    near: z.number(),
    far: z.number()
  }),
  cameraBookmarks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      camera: z.object({
        mode: z.enum(["perspective", "orthographic"]),
        position: vector3Schema,
        target: vector3Schema,
        fov: z.number(),
        zoom: z.number(),
        near: z.number(),
        far: z.number()
      })
    })
  ),
  time: z.object({
    running: z.boolean(),
    speed: z.union([z.literal(0.125), z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)]),
    fixedStepSeconds: z.number(),
    elapsedSimSeconds: z.number()
  }),
  assets: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["hdri", "gaussian-splat", "generic"]),
      relativePath: z.string(),
      sourceFileName: z.string(),
      byteSize: z.number()
    })
  )
});

export function parseSession(payload: string): SessionManifest {
  const input = JSON.parse(payload) as unknown;
  const parsed = sessionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Session parse failed: ${parsed.error.message}`);
  }
  if (parsed.data.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new Error(
      `Session schema version ${parsed.data.schemaVersion} is newer than supported version ${SESSION_SCHEMA_VERSION}.`
    );
  }
  return parsed.data;
}

export function serializeSession(session: SessionManifest): string {
  return JSON.stringify(session, null, 2);
}


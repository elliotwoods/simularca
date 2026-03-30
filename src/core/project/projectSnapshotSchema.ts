import { z } from "zod";
import { DEFAULT_SCENE_HELPERS } from "@/core/defaults";
import { PROJECT_SCHEMA_VERSION } from "@/core/types";
import type { ProjectSnapshotManifest } from "@/core/types";

const vector3Schema = z.tuple([z.number(), z.number(), z.number()]);
const parameterValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(parameterValueSchema), z.record(parameterValueSchema)])
);

function assertNoRemovedNativeGaussianSplatContent(input: unknown): void {
  if (!input || typeof input !== "object") {
    return;
  }
  const payload = input as {
    actors?: Record<string, { actorType?: unknown }>;
    assets?: Array<{ kind?: unknown; encoding?: unknown; relativePath?: unknown }>;
  };
  const hasRemovedActor = Object.values(payload.actors ?? {}).some((actor) => actor?.actorType === "gaussian-splat");
  const hasRemovedAsset = (payload.assets ?? []).some(
    (asset) =>
      asset?.kind === "gaussian-splat" ||
      asset?.encoding === "splatbin-v1" ||
      (typeof asset?.relativePath === "string" && asset.relativePath.toLowerCase().endsWith(".splatbin"))
  );
  if (hasRemovedActor || hasRemovedAsset) {
    throw new Error(
      "This project uses the removed native Gaussian Splat system. Recreate those actors/assets with the current Gaussian Splat actor."
    );
  }
}

function migrateLegacyDxfActors(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const payload = input as {
    actors?: Record<string, {
      actorType?: unknown;
      pluginType?: unknown;
    }>;
    schemaVersion?: unknown;
  };
  if (!payload.actors) {
    return input;
  }
  let changed = false;
  const actors = Object.fromEntries(
    Object.entries(payload.actors).map(([actorId, actor]) => {
      if (actor?.actorType !== "dxf-reference") {
        return [actorId, actor];
      }
      changed = true;
      return [
        actorId,
        {
          ...actor,
          actorType: "plugin",
          pluginType: "plugin.dxfDrawing.actor"
        }
      ];
    })
  );
  if (!changed) {
    return input;
  }
  return {
    ...payload,
    schemaVersion: typeof payload.schemaVersion === "number" ? Math.max(payload.schemaVersion, PROJECT_SCHEMA_VERSION) : PROJECT_SCHEMA_VERSION,
    actors
  };
}

function migrateLegacyGaussianSplatActors(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const payload = input as {
    actors?: Record<string, {
      actorType?: unknown;
      pluginType?: unknown;
      params?: Record<string, unknown>;
    }>;
    schemaVersion?: unknown;
  };
  if (!payload.actors) {
    return input;
  }
  let changed = false;
  const actors = Object.fromEntries(
    Object.entries(payload.actors).map(([actorId, actor]) => {
      if (!actor || typeof actor !== "object") {
        return [actorId, actor];
      }
      if (actor.actorType === "gaussian-splat-spark") {
        changed = true;
        const nextParams = { ...(actor.params ?? {}) };
        delete nextParams.stochasticDepth;
        return [
          actorId,
          {
            ...actor,
            actorType: "plugin",
            pluginType: "plugin.gaussianSplat",
            params: nextParams
          }
        ];
      }
      if (actor.actorType === "plugin" && actor.pluginType === "plugin.gaussianSplat.webgpu") {
        changed = true;
        return [
          actorId,
          {
            ...actor,
            pluginType: "plugin.gaussianSplat"
          }
        ];
      }
      return [actorId, actor];
    })
  );
  if (!changed) {
    return input;
  }
  return {
    ...payload,
    schemaVersion: typeof payload.schemaVersion === "number" ? Math.max(payload.schemaVersion, PROJECT_SCHEMA_VERSION) : PROJECT_SCHEMA_VERSION,
    actors
  };
}

const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.literal("actor"),
  actorType: z.enum([
    "empty",
    "environment",
    "mist-volume",
    "mesh",
    "dxf-reference",
    "primitive",
    "curve",
    "camera-path",
    "plugin"
  ]),
  visibilityMode: z.enum(["visible", "hidden", "selected"]).default("visible"),
  pluginType: z.string().optional(),
  parentActorId: z.string().nullable(),
  childActorIds: z.array(z.string()),
  componentIds: z.array(z.string()),
  transform: z.object({
    position: vector3Schema,
    rotation: vector3Schema,
    scale: vector3Schema
  }),
  params: z.record(parameterValueSchema)
});

const componentSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.literal("component"),
  parentActorId: z.string().nullable(),
  componentType: z.string(),
  schemaId: z.string(),
  params: z.record(parameterValueSchema)
});

const pluginViewSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  actorId: z.string(),
  viewType: z.string(),
  tabId: z.string(),
  title: z.string(),
  open: z.boolean(),
  preferredTabsetId: z.string().nullable()
});

const materialColorChannelSchema = z.union([
  z.object({ mode: z.literal("color"), color: z.string() }),
  z.object({ mode: z.literal("image"), assetId: z.string() }),
  z.string().transform((color) => ({ mode: "color" as const, color }))
]);

const materialScalarChannelSchema = z.union([
  z.object({ mode: z.literal("scalar"), value: z.number() }),
  z.object({ mode: z.literal("image"), assetId: z.string() }),
  z.number().transform((value) => ({ mode: "scalar" as const, value }))
]);

const materialSchema = z.object({
  id: z.string(),
  name: z.string(),
  albedo: materialColorChannelSchema,
  metalness: materialScalarChannelSchema,
  roughness: materialScalarChannelSchema,
  normalMap: z.object({ assetId: z.string() }).nullable().default(null),
  emissive: materialColorChannelSchema,
  emissiveIntensity: z.number(),
  opacity: z.number(),
  transparent: z.boolean(),
  side: z.enum(["front", "back", "double"]),
  wireframe: z.boolean()
});

const projectSnapshotSchema = z.object({
  schemaVersion: z.number(),
  appMode: z.enum(["electron-rw", "web-ro"]),
  projectName: z.string().optional(),
  sessionName: z.string().optional(),
  snapshotName: z.string().default("main"),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
  scene: z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    kind: z.literal("scene"),
    actorIds: z.array(z.string()),
    sceneComponentIds: z.array(z.string()),
    backgroundColor: z.string().default("#070b12"),
    renderEngine: z.enum(["webgl2", "webgpu"]).default("webgl2"),
    antialiasing: z.boolean().default(true),
    framePacing: z
      .object({
        mode: z.enum(["vsync", "fixed"]).default("vsync"),
        targetFps: z.number().default(60)
      })
      .default({
        mode: "vsync",
        targetFps: 60
      }),
    tonemapping: z
      .object({
        mode: z.enum(["off", "aces"]).default("aces"),
        dither: z.boolean().default(true)
      })
      .default({
        mode: "aces",
        dither: true
      }),
    postProcessing: z
      .object({
        bloom: z
          .object({
            enabled: z.boolean().default(false),
            strength: z.number().default(0.6),
            radius: z.number().default(0.2),
            threshold: z.number().default(0.85)
          })
          .default({
            enabled: false,
            strength: 0.6,
            radius: 0.2,
            threshold: 0.85
          }),
        vignette: z
          .object({
            enabled: z.boolean().default(false),
            offset: z.number().default(1),
            darkness: z.number().default(0.35)
          })
          .default({
            enabled: false,
            offset: 1,
            darkness: 0.35
          }),
        chromaticAberration: z
          .object({
            enabled: z.boolean().default(false),
            offset: z.number().default(0.0015)
          })
          .default({
            enabled: false,
            offset: 0.0015
          }),
        grain: z
          .object({
            enabled: z.boolean().default(false),
            intensity: z.number().default(0.02)
          })
          .default({
            enabled: false,
            intensity: 0.02
          })
      })
      .default({
        bloom: {
          enabled: false,
          strength: 0.6,
          radius: 0.2,
          threshold: 0.85
        },
        vignette: {
          enabled: false,
          offset: 1,
          darkness: 0.35
        },
        chromaticAberration: {
          enabled: false,
          offset: 0.0015
        },
        grain: {
          enabled: false,
          intensity: 0.02
        }
      }),
    helpers: z
      .object({
        grid: z
          .object({
            visible: z.boolean().default(DEFAULT_SCENE_HELPERS.grid.visible),
            size: z.number().default(DEFAULT_SCENE_HELPERS.grid.size),
            divisions: z.number().default(DEFAULT_SCENE_HELPERS.grid.divisions),
            majorColor: z.string().default(DEFAULT_SCENE_HELPERS.grid.majorColor),
            minorColor: z.string().default(DEFAULT_SCENE_HELPERS.grid.minorColor),
            opacity: z.number().default(DEFAULT_SCENE_HELPERS.grid.opacity)
          })
          .default(structuredClone(DEFAULT_SCENE_HELPERS.grid)),
        axes: z
          .object({
            visible: z.boolean().default(DEFAULT_SCENE_HELPERS.axes.visible),
            size: z.number().default(DEFAULT_SCENE_HELPERS.axes.size),
            xColor: z.string().default(DEFAULT_SCENE_HELPERS.axes.xColor),
            yColor: z.string().default(DEFAULT_SCENE_HELPERS.axes.yColor),
            zColor: z.string().default(DEFAULT_SCENE_HELPERS.axes.zColor),
            opacity: z.number().default(DEFAULT_SCENE_HELPERS.axes.opacity)
          })
          .default(structuredClone(DEFAULT_SCENE_HELPERS.axes))
      })
      .default(structuredClone(DEFAULT_SCENE_HELPERS)),
    cameraKeyboardNavigation: z.boolean().default(true),
    cameraNavigationSpeed: z.number().default(6),
    cameraFlyLookInvertYaw: z.boolean().default(true),
    cameraFlyLookSpeed: z.number().default(1)
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
  lastPerspectiveCamera: z.object({
    mode: z.enum(["perspective", "orthographic"]),
    position: vector3Schema,
    target: vector3Schema,
    fov: z.number(),
    zoom: z.number(),
    near: z.number(),
    far: z.number()
  }).nullable().optional(),
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
  ).optional(),
  time: z.object({
    running: z.boolean(),
    speed: z.union([z.literal(0.125), z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)]),
    fixedStepSeconds: z.number(),
    elapsedSimSeconds: z.number()
  }),
  pluginViews: z.record(pluginViewSchema).default({}),
  materials: z.record(materialSchema).default({}),
  assets: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["hdri", "generic", "image"]),
      encoding: z.enum(["raw", "ktx2"]).optional(),
      relativePath: z.string(),
      sourceFileName: z.string(),
      byteSize: z.number()
    })
  )
});

export function parseProjectSnapshot(payload: string): ProjectSnapshotManifest {
  const input = JSON.parse(payload) as unknown;
  const migratedInput = migrateLegacyGaussianSplatActors(migrateLegacyDxfActors(input));
  assertNoRemovedNativeGaussianSplatContent(migratedInput);
  const parsed = projectSnapshotSchema.safeParse(migratedInput);
  if (!parsed.success) {
    throw new Error(`Project snapshot parse failed: ${parsed.error.message}`);
  }
  if (parsed.data.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Project schema version ${parsed.data.schemaVersion} is newer than supported version ${PROJECT_SCHEMA_VERSION}.`
    );
  }
  return {
    ...parsed.data,
    projectName: parsed.data.projectName ?? parsed.data.sessionName ?? "demo",
    snapshotName: parsed.data.snapshotName ?? "main",
    lastPerspectiveCamera:
      parsed.data.lastPerspectiveCamera ??
      (parsed.data.camera.mode === "perspective" ? parsed.data.camera : null)
  };
}

export function serializeProjectSnapshot(project: ProjectSnapshotManifest): string {
  return JSON.stringify(project, null, 2);
}




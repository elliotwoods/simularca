import { z } from "zod";

/**
 * Viewer feature toggles selected by the publisher in PublishModal. Stored
 * alongside the manifest as `publishConfig-<contentSha>.json` and consumed by
 * the viewer kernel to gate UI panels and interactions.
 *
 * Default values describe the standard "share a snapshot" experience: scene
 * tree + inspector visible, console hidden, transform gizmo off. Publishers
 * can override any field.
 */
export const viewerPermissionsSchema = z
  .object({
    canEditParameters: z.boolean().default(false),
    canToggleVisibility: z.boolean().default(false),
    canCreateActors: z.boolean().default(false),
    canDeleteActors: z.boolean().default(false),
    canTransformActors: z.boolean().default(false)
  })
  .default({});

export type ViewerPermissions = z.infer<typeof viewerPermissionsSchema>;

export function defaultViewerPermissions(): ViewerPermissions {
  return viewerPermissionsSchema.parse({});
}

export const publishConfigSchema = z.object({
  configVersion: z.literal(1),
  panels: z.object({
    sceneTree: z.boolean().default(true),
    inspector: z.boolean().default(true),
    console: z.boolean().default(false),
    snapshotPicker: z.boolean().default(true)
  }),
  interactions: z.object({
    transformGizmo: z.boolean().default(false),
    axisWidget: z.boolean().default(true),
    viewPresets: z.boolean().default(true),
    postProcessing: z.boolean().default(true),
    orbitPanZoom: z.boolean().default(true)
  }),
  permissions: viewerPermissionsSchema,
  /**
   * Optional FlexLayout `IJsonModel`. When present the viewer uses it as the
   * panel layout verbatim; when absent the viewer derives a default layout
   * from the `panels` flags above (legacy behaviour). Stored as `unknown` so
   * the schema doesn't have to track FlexLayout's internal types.
   */
  layout: z.unknown().optional(),
  branding: z
    .object({
      title: z.string().optional()
    })
    .default({}),
  /**
   * Header bar configuration for the published viewer. `showTitleBar` covers
   * the logo + version + snapshot picker + project title strip. `showToolbar`
   * controls the secondary row below it; individual `toolbar.*` flags choose
   * which sections appear (render/profile/publish are always omitted from the
   * viewer regardless of these flags).
   */
  header: z
    .object({
      showTitleBar: z.boolean().default(true),
      showToolbar: z.boolean().default(true),
      toolbar: z
        .object({
          camera: z.boolean().default(true),
          time: z.boolean().default(true),
          fps: z.boolean().default(true),
          edit: z.boolean().default(false),
          materials: z.boolean().default(false),
          keyboard: z.boolean().default(false)
        })
        .default({})
    })
    .default({})
});

export type PublishConfig = z.infer<typeof publishConfigSchema>;

export function defaultPublishConfig(): PublishConfig {
  return publishConfigSchema.parse({
    configVersion: 1,
    panels: {},
    interactions: {},
    permissions: {},
    branding: {}
  });
}

export function parsePublishConfig(payload: string): PublishConfig {
  return publishConfigSchema.parse(JSON.parse(payload) as unknown);
}

export function serializePublishConfig(config: PublishConfig): string {
  return JSON.stringify(config, null, 2);
}

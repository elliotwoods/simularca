import { z } from "zod";

/**
 * On-the-wire shape of the publish manifest. Stored at
 * `publishes/<publishId>/manifest-<contentSha>.json` in the user's R2 bucket.
 * The mutable `latest.json` pointer (see `latestPointerSchema`) names which
 * manifest sha is currently live.
 *
 * URLs in this manifest are bucket-relative; the viewer prepends the bucket
 * base URL (received via the `?b=` query parameter) when fetching.
 */
export const publishManifestSchema = z.object({
  manifestVersion: z.literal(1),
  publishId: z.string().min(1),
  title: z.string(),
  publishedAtIso: z.string(),
  /**
   * `commitShortSha` of the editor build that produced this manifest. The
   * viewer at `/v/<sha>/` must equal this to guarantee schema compatibility;
   * the publish UI pre-flights `HEAD /v/<sha>/viewer.html` before allowing
   * publish to proceed.
   */
  requiredViewerSha: z.string().min(1),
  appBuild: z.object({
    version: z.string(),
    commitShortSha: z.string()
  }),
  project: z.object({
    uuid: z.string().uuid(),
    name: z.string()
  }),
  snapshots: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().min(1),
        schemaVersion: z.number().int().nonnegative(),
        default: z.boolean().optional()
      })
    )
    .min(1),
  /**
   * Map keyed by `${projectUuid}/${relativePath}` (matching the existing
   * StorageAdapter.resolveAssetPath signature) → bucket-relative URL.
   */
  assets: z.record(z.string(), z.string()),
  plugins: z
    .array(
      z.object({
        id: z.string().min(1),
        version: z.string(),
        url: z.string().min(1),
        core: z.boolean(),
        externals: z.record(z.string(), z.string())
      })
    )
    .default([]),
  publishConfigUrl: z.string().min(1),
  /**
   * Optional social-card / OpenGraph thumbnail. Captured from the editor's
   * viewport at publish time, uploaded to the bucket alongside other
   * publish blobs. The Vercel routing middleware reads `thumbnail.url` and
   * injects it as `<meta property="og:image">` when crawlers (or anyone)
   * fetch `/v/<sha>/p/<publishId>`.
   */
  thumbnail: z
    .object({
      url: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      contentType: z.string().min(1)
    })
    .optional()
});

export type PublishManifest = z.infer<typeof publishManifestSchema>;

/**
 * The single mutable pointer per publish. Atomic re-publish == one PUT of
 * this file. Free rollback == PUT a previous manifest sha.
 */
export const latestPointerSchema = z.object({
  latestVersion: z.literal(1),
  manifestUrl: z.string().min(1)
});

export type LatestPointer = z.infer<typeof latestPointerSchema>;

export function parsePublishManifest(payload: string): PublishManifest {
  return publishManifestSchema.parse(JSON.parse(payload) as unknown);
}

export function parseLatestPointer(payload: string): LatestPointer {
  return latestPointerSchema.parse(JSON.parse(payload) as unknown);
}

export function serializePublishManifest(manifest: PublishManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function serializeLatestPointer(pointer: LatestPointer): string {
  return JSON.stringify(pointer, null, 2);
}

/**
 * Build the asset-map key consistently between publish and viewer. The choice
 * to key by `${projectUuid}/${relativePath}` matches the existing
 * `StorageAdapter.resolveAssetPath({ projectUuid, relativePath })` signature
 * so the viewer's web adapter can look up assets without renormalising.
 */
export function buildAssetKey(projectUuid: string, relativePath: string): string {
  return `${projectUuid}/${relativePath}`;
}

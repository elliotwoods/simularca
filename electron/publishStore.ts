import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

/**
 * Persistent publish settings, keyed by user-named target. Lives at
 * `app.getPath("userData")/publish-settings.json`.
 *
 * Pure module (no Electron imports) so it can be unit-tested. The Vercel
 * token is stored as base64-encoded `safeStorage.encryptString` output; the
 * encrypt/decrypt happens in `electron/main.ts` where `safeStorage` is
 * available, and only the encoded bytes round-trip through this file.
 */

export const PUBLISH_SETTINGS_FILE_NAME = "publish-settings.json";
export const PUBLISH_SETTINGS_SCHEMA_VERSION = 1;

export const R2CredentialsSchema = z.object({
  accountId: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().optional()
});
export type R2Credentials = z.infer<typeof R2CredentialsSchema>;

export const SelfHostedViewerSchema = z.object({
  vercelTokenEncryptedBase64: z.string().optional(),
  vercelProjectId: z.string().optional(),
  vercelTeamId: z.string().optional()
});
export type SelfHostedViewer = z.infer<typeof SelfHostedViewerSchema>;

export const PublishTargetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  r2: R2CredentialsSchema,
  /** Public R2 URL or custom domain. No trailing slash; we trim on save. */
  bucketBaseUrl: z.string().min(1),
  /** e.g. https://simularca-viewer.vercel.app or a self-hosted equivalent. */
  viewerUrl: z.string().min(1),
  selfHosted: SelfHostedViewerSchema.optional(),
  /** Optional GC retention; default 10 manifests/publish. */
  manifestRetention: z.number().int().min(1).max(500).optional()
});
export type PublishTarget = z.infer<typeof PublishTargetSchema>;

/**
 * Catalogue of blobs a single publish *references* on R2, recorded at publish
 * time so the UI can compute per-publish size and target-wide dedup'd usage
 * without ListBucket permission.
 *
 * `kind: "asset"` blobs (under `assets/sha256/`) are content-addressed and
 * shared across publishes — deleting a publish must NOT delete them. The
 * other kinds live under `publishes/<id>/` and are safe to delete.
 */
export const PublishBlobRefSchema = z.object({
  sha: z.string().min(1),
  /** Bucket-relative key (e.g. `assets/sha256/abc...` or `publishes/<id>/...`). */
  key: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  kind: z.enum(["asset", "plugin", "snapshot", "config", "manifest", "latest"])
});
export type PublishBlobRef = z.infer<typeof PublishBlobRefSchema>;

export const ListedPublishSchema = z.object({
  publishId: z.string().min(1),
  title: z.string(),
  lastPublishedAtIso: z.string(),
  targetId: z.string().min(1),
  /** URL of the viewer for this publish (sha-pinned, includes ?b=). */
  viewerUrl: z.string().optional(),
  /** Sha of the viewer this publish was pinned to at publish time. */
  requiredViewerSha: z.string().optional(),
  referencedBlobs: z.array(PublishBlobRefSchema).default([])
});
export type ListedPublish = z.infer<typeof ListedPublishSchema>;

/**
 * Top-level Vercel credentials used to deploy the central viewer bundle.
 * Distinct from per-target self-hosted Vercel settings: there's one viewer
 * deployment per machine (the viewer is just a static bundle keyed by sha;
 * all publish targets on the same machine share it).
 */
export const VercelDeploySettingsSchema = z.object({
  vercelTokenEncryptedBase64: z.string().optional(),
  vercelProjectId: z.string().optional(),
  vercelProjectName: z.string().optional(),
  vercelTeamId: z.string().optional(),
  /** Cached on save so the UI can display "signed in as foo@bar.com" without re-probing. */
  cachedAccountLabel: z.string().optional(),
  /** ISO timestamp of last successful /v2/user probe. */
  lastVerifiedAtIso: z.string().optional(),
  /** The most recent commit-short-sha that was successfully deployed as a
   *  viewer. The publish UI offers this as a fallback when the editor's
   *  current sha isn't yet deployed. */
  lastDeployedSha: z.string().optional(),
  lastDeployedAtIso: z.string().optional()
});
export type VercelDeploySettings = z.infer<typeof VercelDeploySettingsSchema>;

export const PublishSettingsSchema = z.object({
  schemaVersion: z.literal(PUBLISH_SETTINGS_SCHEMA_VERSION),
  targets: z.array(PublishTargetSchema).default([]),
  defaultTargetId: z.string().optional(),
  publishesByProjectUuid: z.record(z.string(), z.array(ListedPublishSchema)).default({}),
  viewerDeployment: VercelDeploySettingsSchema.optional(),
  /**
   * Publisher's saved-for-next-time defaults. Used to pre-fill the publish
   * modal so a layout the user tweaked once is reused on subsequent publishes
   * across projects on this machine.
   */
  defaultPublishLayout: z.unknown().optional(),
  defaultViewerPermissions: z.unknown().optional()
});
export type PublishSettings = z.infer<typeof PublishSettingsSchema>;

function emptySettings(): PublishSettings {
  return {
    schemaVersion: PUBLISH_SETTINGS_SCHEMA_VERSION,
    targets: [],
    publishesByProjectUuid: {}
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeForSave(settings: PublishSettings): PublishSettings {
  return {
    ...settings,
    targets: settings.targets.map((target) => ({
      ...target,
      bucketBaseUrl: trimTrailingSlash(target.bucketBaseUrl),
      viewerUrl: trimTrailingSlash(target.viewerUrl)
    }))
  };
}

export async function loadPublishSettings(filePath: string): Promise<PublishSettings> {
  if (!fs.existsSync(filePath)) {
    return emptySettings();
  }
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = PublishSettingsSchema.safeParse(parsed);
    if (!result.success) {
      // Settings shape changed or got corrupted; start fresh rather than
      // throwing, but keep a backup so the user can recover by hand.
      try {
        await fsp.copyFile(filePath, `${filePath}.corrupted-${String(Date.now())}.bak`);
      } catch {
        // ignore
      }
      return emptySettings();
    }
    return result.data;
  } catch {
    return emptySettings();
  }
}

export async function savePublishSettings(filePath: string, settings: PublishSettings): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeForSave(settings);
  // Atomic-ish write: write to tmp file then rename.
  const tmp = `${filePath}.tmp-${String(process.pid)}`;
  await fsp.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}

/**
 * Returns the requested target plus a flat `RedactedPublishSettings` for the
 * renderer (no plaintext secrets). The `hasR2Secret` boolean lets the UI show
 * "configured" without ever shipping the key over IPC.
 */
export interface RedactedPublishTarget {
  id: string;
  label: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    bucket: string;
    region?: string;
    hasSecret: boolean;
  };
  bucketBaseUrl: string;
  viewerUrl: string;
  selfHosted?: {
    hasVercelToken: boolean;
    vercelProjectId?: string;
    vercelTeamId?: string;
  };
  manifestRetention?: number;
}

export interface RedactedVercelDeploySettings {
  hasVercelToken: boolean;
  vercelProjectId?: string;
  vercelProjectName?: string;
  vercelTeamId?: string;
  cachedAccountLabel?: string;
  lastVerifiedAtIso?: string;
  lastDeployedSha?: string;
  lastDeployedAtIso?: string;
}

export interface RedactedPublishSettings {
  schemaVersion: number;
  targets: RedactedPublishTarget[];
  defaultTargetId?: string;
  publishesByProjectUuid: Record<string, ListedPublish[]>;
  viewerDeployment?: RedactedVercelDeploySettings;
  defaultPublishLayout?: unknown;
  defaultViewerPermissions?: unknown;
}

export function redactVercelDeploy(settings: VercelDeploySettings | undefined): RedactedVercelDeploySettings | undefined {
  if (!settings) return undefined;
  return {
    hasVercelToken: Boolean(settings.vercelTokenEncryptedBase64),
    vercelProjectId: settings.vercelProjectId,
    vercelProjectName: settings.vercelProjectName,
    vercelTeamId: settings.vercelTeamId,
    cachedAccountLabel: settings.cachedAccountLabel,
    lastVerifiedAtIso: settings.lastVerifiedAtIso,
    lastDeployedSha: settings.lastDeployedSha,
    lastDeployedAtIso: settings.lastDeployedAtIso
  };
}

export function redactSettings(settings: PublishSettings): RedactedPublishSettings {
  return {
    schemaVersion: settings.schemaVersion,
    defaultTargetId: settings.defaultTargetId,
    publishesByProjectUuid: settings.publishesByProjectUuid,
    viewerDeployment: redactVercelDeploy(settings.viewerDeployment),
    defaultPublishLayout: settings.defaultPublishLayout,
    defaultViewerPermissions: settings.defaultViewerPermissions,
    targets: settings.targets.map((target) => ({
      id: target.id,
      label: target.label,
      r2: {
        accountId: target.r2.accountId,
        accessKeyId: target.r2.accessKeyId,
        bucket: target.r2.bucket,
        region: target.r2.region,
        hasSecret: target.r2.secretAccessKey.length > 0
      },
      bucketBaseUrl: target.bucketBaseUrl,
      viewerUrl: target.viewerUrl,
      selfHosted: target.selfHosted
        ? {
            hasVercelToken: Boolean(target.selfHosted.vercelTokenEncryptedBase64),
            vercelProjectId: target.selfHosted.vercelProjectId,
            vercelTeamId: target.selfHosted.vercelTeamId
          }
        : undefined,
      manifestRetention: target.manifestRetention
    }))
  };
}

export function findTarget(settings: PublishSettings, targetId: string): PublishTarget | null {
  return settings.targets.find((target) => target.id === targetId) ?? null;
}

export function setDefaultPublishLayout(
  settings: PublishSettings,
  layout: unknown
): PublishSettings {
  return { ...settings, defaultPublishLayout: layout ?? undefined };
}

export function setDefaultViewerPermissions(
  settings: PublishSettings,
  permissions: unknown
): PublishSettings {
  return { ...settings, defaultViewerPermissions: permissions ?? undefined };
}

/**
 * Insert or replace a publish entry under the given project. Returns the new
 * settings (caller is responsible for `savePublishSettings`).
 */
export function recordPublish(
  settings: PublishSettings,
  projectUuid: string,
  entry: ListedPublish
): PublishSettings {
  const existing = settings.publishesByProjectUuid[projectUuid] ?? [];
  const filtered = existing.filter((item) => item.publishId !== entry.publishId);
  return {
    ...settings,
    publishesByProjectUuid: {
      ...settings.publishesByProjectUuid,
      [projectUuid]: [entry, ...filtered]
    }
  };
}

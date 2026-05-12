/**
 * Viewer-version helpers + Vercel deployment.
 *
 * Two paths:
 *   1. `checkViewerVersion` — a no-credential HEAD against
 *      `${viewerUrl}/v/<sha>/viewer.html` used by the publish pre-flight.
 *   2. `verifyVercelToken` + `deployViewer` — drive a Vercel deployment of
 *      the local `dist/v/<sha>/` bundle using `@vercel/client`. Lets the
 *      Simularca UI push the viewer to Vercel directly without the user
 *      ever touching `vercel` CLI.
 */

import { createDeployment } from "@vercel/client";

export interface CheckViewerVersionArgs {
  viewerUrl: string;
  sha: string;
}

export interface CheckViewerVersionResult {
  deployed: boolean;
  status?: number;
  error?: string;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function checkViewerVersion(args: CheckViewerVersionArgs): Promise<CheckViewerVersionResult> {
  const { viewerUrl, sha } = args;
  if (!viewerUrl || !sha) {
    return { deployed: false, error: "viewerUrl and sha are required." };
  }
  const targetUrl = `${trimTrailingSlash(viewerUrl)}/v/${encodeURIComponent(sha)}/viewer.html`;
  try {
    const response = await fetch(targetUrl, { method: "HEAD" });
    return { deployed: response.ok, status: response.status };
  } catch (error) {
    return {
      deployed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// --------------------------------------------------------------------------
// Token verification
// --------------------------------------------------------------------------

export interface VerifyVercelTokenArgs {
  token: string;
  teamId?: string;
}

export interface VerifyVercelTokenResult {
  ok: boolean;
  email?: string;
  username?: string;
  userId?: string;
  teamSlug?: string;
  error?: string;
}

interface VercelUserResponse {
  user?: {
    id?: string;
    email?: string;
    username?: string;
    name?: string;
  };
}

interface VercelTeamResponse {
  id?: string;
  slug?: string;
  name?: string;
}

export async function verifyVercelToken(args: VerifyVercelTokenArgs): Promise<VerifyVercelTokenResult> {
  if (!args.token.trim()) {
    return { ok: false, error: "Vercel token is required." };
  }
  try {
    const userResponse = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${args.token}` }
    });
    if (!userResponse.ok) {
      const text = await userResponse.text().catch(() => "");
      if (userResponse.status === 401 || userResponse.status === 403) {
        return {
          ok: false,
          error: "Vercel rejected the token. Re-check it has scope 'Full Account' (or is scoped to the target team)."
        };
      }
      return {
        ok: false,
        error: `Vercel /v2/user failed (${String(userResponse.status)}): ${text.slice(0, 200)}`
      };
    }
    const userJson = (await userResponse.json()) as VercelUserResponse;
    const user = userJson.user;
    let teamSlug: string | undefined;
    if (args.teamId) {
      const teamResponse = await fetch(
        `https://api.vercel.com/v2/teams/${encodeURIComponent(args.teamId)}`,
        { headers: { Authorization: `Bearer ${args.token}` } }
      );
      if (!teamResponse.ok) {
        return {
          ok: false,
          error: `Team "${args.teamId}" not accessible with this token (${String(teamResponse.status)}). Verify the team ID and that the token has access.`
        };
      }
      const team = (await teamResponse.json()) as VercelTeamResponse;
      teamSlug = team.slug;
    }
    return {
      ok: true,
      email: user?.email,
      username: user?.username,
      userId: user?.id,
      teamSlug
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// --------------------------------------------------------------------------
// Project lookup
// --------------------------------------------------------------------------

interface VercelProject {
  id: string;
  name: string;
}

interface VercelProjectsListResponse {
  projects?: VercelProject[];
}

async function findProjectByName(args: {
  token: string;
  teamId?: string;
  name: string;
}): Promise<VercelProject | null> {
  const url = new URL("https://api.vercel.com/v9/projects");
  url.searchParams.set("search", args.name);
  if (args.teamId) url.searchParams.set("teamId", args.teamId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.token}` }
  });
  if (!response.ok) return null;
  const body = (await response.json()) as VercelProjectsListResponse;
  const match = body.projects?.find((entry) => entry.name === args.name);
  return match ?? null;
}

async function createProject(args: {
  token: string;
  teamId?: string;
  name: string;
}): Promise<VercelProject> {
  const url = new URL("https://api.vercel.com/v11/projects");
  if (args.teamId) url.searchParams.set("teamId", args.teamId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: args.name, framework: null })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Vercel project create failed (${String(response.status)}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as VercelProject;
  return body;
}

export interface EnsureProjectArgs {
  token: string;
  teamId?: string;
  name: string;
}

export interface EnsureProjectResult {
  projectId: string;
  name: string;
  created: boolean;
}

export async function ensureVercelProject(args: EnsureProjectArgs): Promise<EnsureProjectResult> {
  const existing = await findProjectByName(args);
  if (existing) {
    return { projectId: existing.id, name: existing.name, created: false };
  }
  const created = await createProject(args);
  return { projectId: created.id, name: created.name, created: true };
}

// --------------------------------------------------------------------------
// Viewer deployment (via @vercel/client)
// --------------------------------------------------------------------------

export type DeployViewerPhase =
  | "preparing"
  | "uploading"
  | "deploying"
  | "ready"
  | "error";

export interface DeployViewerProgressEvent {
  phase: DeployViewerPhase;
  message?: string;
  uploadedFiles?: number;
  totalFiles?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  url?: string;
  error?: string;
}

export interface DeployViewerArgs {
  token: string;
  /** Pre-created Vercel project name (or one that will be created on first deploy). */
  projectName: string;
  /** Optional team ID. If absent, deploys under the personal account. */
  teamId?: string;
  /** Local directory to deploy (e.g. `dist/`). */
  distDir: string;
  /**
   * Editor commit short sha — used as the deployment alias prefix. The
   * specific viewer entry path is `/v/<sha>/viewer.html` and is included
   * in the deployed bundle by `scripts/build-viewer.mjs`.
   */
  sha: string;
  onProgress?: (event: DeployViewerProgressEvent) => void;
  signal?: AbortSignal;
}

export interface DeployViewerResult {
  url: string;
  inspectUrl?: string;
  alias?: string[];
}

interface VercelClientDeploymentEvent {
  type: string;
  payload?: {
    url?: string;
    inspectorUrl?: string;
    alias?: string[];
    [key: string]: unknown;
  };
}

export async function deployViewer(args: DeployViewerArgs): Promise<DeployViewerResult> {
  const emit = (event: DeployViewerProgressEvent): void => {
    args.onProgress?.(event);
  };
  emit({ phase: "preparing", message: "Calculating file hashes…" });

  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;

  // `@vercel/client.createDeployment` yields a stream of events as it hashes,
  // uploads, and creates the deployment. We surface progress at the natural
  // event boundaries and translate them into our DeployViewerProgressEvent
  // vocabulary.
  const eventStream = createDeployment(
    {
      token: args.token,
      teamId: args.teamId,
      path: args.distDir,
      // MUST be the full URL including protocol. Two gotchas in
      // @vercel/client (verified against ^17.4.2):
      //   1. utils/index.js concatenates apiUrl + path; passing a bare
      //      host like "api.vercel.com" produces "api.vercel.com/v9/..."
      //      which Node fetch rejects with "only absolute URLs supported".
      //   2. upload.js picks the agent via `apiUrl?.startsWith("https://")`
      //      — if apiUrl is undefined, it falls back to an http agent and
      //      then the actual https fetch fails with
      //      ERR_INVALID_PROTOCOL "Protocol https: not supported".
      // So the only working value is the full URL including protocol.
      apiUrl: "https://api.vercel.com",
      userAgent: "simularca-publish/1"
    },
    {
      name: args.projectName,
      target: "production",
      // Explicit `builds` tells Vercel to use the static builder. Without it,
      // the deployment sits in QUEUED forever because Vercel auto-detection
      // doesn't know what to do with a `framework: null` project that has
      // no buildCommand / outputDirectory configured.
      builds: [{ src: "**", use: "@vercel/static" }],
      projectSettings: {
        framework: null,
        buildCommand: null,
        outputDirectory: null,
        installCommand: null,
        devCommand: null
      }
    } as Parameters<typeof createDeployment>[1]
  );

  let deploymentUrl: string | undefined;
  let inspectUrl: string | undefined;
  let aliases: string[] | undefined;
  let reachedReady = false;

  for await (const rawEvent of eventStream) {
    if (args.signal?.aborted) {
      throw new Error("Viewer deploy cancelled.");
    }
    const event = rawEvent as VercelClientDeploymentEvent;
    switch (event.type) {
      case "hashes-calculated": {
        const filesByHash = event.payload as Record<string, { data?: Buffer; sha?: string }> | undefined;
        if (filesByHash && typeof filesByHash === "object") {
          totalFiles = Object.keys(filesByHash).length;
          totalBytes = 0;
          for (const entry of Object.values(filesByHash)) {
            const data = entry?.data;
            if (data && typeof (data as Buffer).byteLength === "number") {
              totalBytes += (data as Buffer).byteLength;
            }
          }
        }
        emit({
          phase: "uploading",
          message: `Hashed ${String(totalFiles)} file(s) (${formatBytes(totalBytes)}).`,
          totalFiles,
          totalBytes,
          uploadedFiles: 0,
          uploadedBytes: 0
        });
        break;
      }
      case "file-count": {
        const count = (event.payload as unknown as number) ?? 0;
        totalFiles = totalFiles || count;
        emit({
          phase: "uploading",
          message: `Uploading ${String(count)} file(s)…`,
          totalFiles,
          totalBytes
        });
        break;
      }
      case "file-uploaded": {
        uploadedFiles += 1;
        const payload = event.payload as { file?: { data?: Buffer } } | undefined;
        const data = payload?.file?.data;
        if (data && typeof (data as Buffer).byteLength === "number") {
          uploadedBytes += (data as Buffer).byteLength;
        }
        emit({
          phase: "uploading",
          message: `Uploaded ${String(uploadedFiles)}/${String(totalFiles)} files`,
          uploadedFiles,
          totalFiles,
          uploadedBytes,
          totalBytes
        });
        break;
      }
      case "all-files-uploaded": {
        emit({
          phase: "deploying",
          message: "Files uploaded; creating deployment…",
          uploadedFiles: totalFiles,
          totalFiles,
          uploadedBytes: totalBytes,
          totalBytes
        });
        break;
      }
      case "created": {
        const payload = event.payload ?? {};
        if (typeof payload.url === "string") {
          deploymentUrl = payload.url;
        }
        if (typeof payload.inspectorUrl === "string") {
          inspectUrl = payload.inspectorUrl;
        }
        if (Array.isArray(payload.alias)) {
          aliases = payload.alias.filter((entry): entry is string => typeof entry === "string");
        }
        emit({
          phase: "deploying",
          message: deploymentUrl ? `Deployment created at https://${deploymentUrl} — waiting for ready…` : "Deployment created — waiting for ready…",
          url: deploymentUrl
        });
        break;
      }
      case "ready":
      case "alias-assigned": {
        const payload = event.payload ?? {};
        if (typeof payload.url === "string") deploymentUrl = payload.url;
        if (Array.isArray(payload.alias)) {
          aliases = payload.alias.filter((entry): entry is string => typeof entry === "string");
        }
        emit({
          phase: "ready",
          message: deploymentUrl ? `Ready at https://${deploymentUrl}` : "Ready.",
          url: deploymentUrl
        });
        // `ready` is terminal-success for our use case. `checkDeploymentStatus`
        // keeps polling for `alias-assigned`, which can take a long time (or
        // never fire) for projects without a custom production domain. Break
        // out so the caller can return.
        reachedReady = true;
        break;
      }
      case "canceled": {
        emit({ phase: "error", error: "Vercel deployment was cancelled." });
        throw new Error("Vercel deployment was cancelled.");
      }
      case "error":
      case "checks-v2-failed": {
        // @vercel/client emits "error" with a varied payload shape:
        //   - deploymentUpdate.error (preferred — has .message / .code)
        //   - deploymentUpdate.aliasError
        //   - the full deploymentUpdate (when readyState=ERROR or isFailed)
        // Pull the first message we find, then fall back to a JSON dump so
        // the caller has *something* to go on.
        const payload = event.payload as Record<string, unknown> | undefined;
        const message = extractVercelErrorMessage(payload);
        emit({ phase: "error", error: message });
        throw new Error(message);
      }
      default:
        // Many ancillary events (warning, etc.) — surface only if useful.
        break;
    }
    if (reachedReady) {
      break;
    }
  }

  if (!deploymentUrl) {
    throw new Error("Vercel deploy finished without producing a URL.");
  }
  return { url: deploymentUrl, inspectUrl, alias: aliases };
}

function extractVercelErrorMessage(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "Vercel deploy failed (no payload).";
  const direct = readString(payload, ["message", "errorMessage"]);
  if (direct) return direct;
  const nestedError = payload.error;
  if (isPayloadObject(nestedError)) {
    const nestedMessage = readString(nestedError, ["message", "errorMessage"]);
    if (nestedMessage) {
      const code = readString(nestedError, ["code"]);
      return code ? `${nestedMessage} (${code})` : nestedMessage;
    }
  }
  const aliasError = payload.aliasError;
  if (isPayloadObject(aliasError)) {
    const aliasMsg = readString(aliasError, ["message", "errorMessage"]);
    if (aliasMsg) return `Alias failed: ${aliasMsg}`;
  }
  const errorCode = readString(payload, ["errorCode"]);
  const readyState = readString(payload, ["readyState"]);
  if (errorCode || readyState) {
    const parts: string[] = [];
    if (readyState) parts.push(`readyState=${readyState}`);
    if (errorCode) parts.push(`errorCode=${errorCode}`);
    return `Vercel deploy failed (${parts.join(" ")}). Full payload: ${truncate(JSON.stringify(payload))}`;
  }
  return `Vercel deploy failed. Payload: ${truncate(JSON.stringify(payload))}`;
}

function isPayloadObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…[+${value.length - max} chars]` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --------------------------------------------------------------------------
// Aliasing — once a deployment is ready, alias it to a stable hostname so
// the public URL doesn't churn per deploy.
// --------------------------------------------------------------------------

export async function aliasDeployment(args: {
  token: string;
  teamId?: string;
  deploymentUrl: string;
  alias: string;
}): Promise<void> {
  const url = new URL(`https://api.vercel.com/v2/deployments/${encodeURIComponent(args.deploymentUrl)}/aliases`);
  if (args.teamId) url.searchParams.set("teamId", args.teamId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ alias: args.alias })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Vercel alias failed (${String(response.status)}): ${text.slice(0, 200)}`);
  }
}

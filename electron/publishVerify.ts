import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { PublishTarget } from "./publishStore.js";

export type ValidationField =
  | "label"
  | "accountId"
  | "accessKeyId"
  | "secretAccessKey"
  | "bucket"
  | "region"
  | "bucketBaseUrl"
  | "viewerUrl"
  | "vercelToken"
  | "vercelProjectId"
  | "general";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  field: ValidationField;
  severity: ValidationSeverity;
  message: string;
}

export interface VerifyTargetResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const CONSECUTIVE_HYPHENS = /--/;
const LOOKS_LIKE_IP = /^\d+\.\d+\.\d+\.\d+$/;

function pushIssue(issues: ValidationIssue[], issue: ValidationIssue): void {
  issues.push(issue);
}

function validateUrl(field: ValidationField, raw: string, issues: ValidationIssue[]): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    pushIssue(issues, { field, severity: "error", message: "Required." });
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    pushIssue(issues, { field, severity: "error", message: "Not a valid URL." });
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    pushIssue(issues, { field, severity: "error", message: `Unsupported protocol "${parsed.protocol}".` });
    return null;
  }
  if (parsed.protocol === "http:") {
    pushIssue(issues, {
      field,
      severity: "warning",
      message: "Plain http://. Public viewer access requires https in most browsers."
    });
  }
  if (trimmed.endsWith("/")) {
    pushIssue(issues, {
      field,
      severity: "info",
      message: "Trailing slash will be stripped on save."
    });
  }
  return parsed;
}

function validateFormatSync(target: PublishTarget): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!target.label.trim()) {
    pushIssue(issues, { field: "label", severity: "error", message: "Required." });
  }

  // R2 Account ID — 32-char hex.
  const accountId = target.r2.accountId.trim();
  if (!accountId) {
    pushIssue(issues, { field: "accountId", severity: "error", message: "Required." });
  } else if (!HEX_32.test(accountId)) {
    if (accountId.length === 36 && accountId.split("-").length === 5) {
      pushIssue(issues, {
        field: "accountId",
        severity: "error",
        message: "Looks like a UUID. R2 Account ID is the 32-char hex shown on your Cloudflare dashboard's right sidebar."
      });
    } else if (/^[a-z0-9-]+$/.test(accountId)) {
      pushIssue(issues, {
        field: "accountId",
        severity: "error",
        message: `"${accountId}" looks like a bucket name or slug, not an Account ID. R2 Account ID is a 32-char hex (e.g. 1234567890abcdef1234567890abcdef) from the Cloudflare dashboard home page.`
      });
    } else {
      pushIssue(issues, {
        field: "accountId",
        severity: "error",
        message: "Account ID must be 32 hexadecimal characters. Copy it from the Cloudflare dashboard home page (right sidebar, under your account name)."
      });
    }
  }

  // Access Key ID — typically 32-char hex for R2.
  const accessKeyId = target.r2.accessKeyId.trim();
  if (!accessKeyId) {
    pushIssue(issues, { field: "accessKeyId", severity: "error", message: "Required." });
  } else if (!HEX_32.test(accessKeyId)) {
    pushIssue(issues, {
      field: "accessKeyId",
      severity: "warning",
      message: "R2 Access Key IDs are normally 32 hexadecimal characters. Double-check this came from 'Manage R2 API Tokens'."
    });
  }

  // Secret Access Key — 64-char hex for R2 when present.
  const secret = target.r2.secretAccessKey;
  if (!secret) {
    pushIssue(issues, {
      field: "secretAccessKey",
      severity: "error",
      message: "Required. The Secret is shown only once when you create the token; if you didn't save it you need to issue a new token."
    });
  } else if (!HEX_64.test(secret)) {
    pushIssue(issues, {
      field: "secretAccessKey",
      severity: "warning",
      message: "R2 Secret Access Keys are normally 64 hexadecimal characters."
    });
  }

  // Bucket — S3 bucket naming rules.
  const bucket = target.r2.bucket.trim();
  if (!bucket) {
    pushIssue(issues, { field: "bucket", severity: "error", message: "Required." });
  } else if (LOOKS_LIKE_IP.test(bucket)) {
    pushIssue(issues, { field: "bucket", severity: "error", message: "Bucket name cannot look like an IPv4 address." });
  } else if (!S3_BUCKET.test(bucket)) {
    pushIssue(issues, {
      field: "bucket",
      severity: "error",
      message: "Bucket names must be 3–63 chars, lowercase alphanumeric and hyphens, starting and ending with alphanumeric."
    });
  } else if (CONSECUTIVE_HYPHENS.test(bucket)) {
    pushIssue(issues, { field: "bucket", severity: "error", message: "Bucket name cannot contain consecutive hyphens." });
  }

  // Region — informational only.
  const region = target.r2.region?.trim();
  if (region && region !== "auto" && region.length > 0) {
    // R2's accepted region codes — leave blank or 'auto' is the common case.
    const knownRegions = new Set(["auto", "wnam", "enam", "weur", "eeur", "apac", "oc"]);
    if (!knownRegions.has(region)) {
      pushIssue(issues, {
        field: "region",
        severity: "warning",
        message: `"${region}" is not a known R2 jurisdiction code. Leave blank (auto) unless you've bound the bucket to a specific region.`
      });
    }
  }

  // Bucket base URL — must parse, https preferred, host should look right.
  const bucketBaseParsed = validateUrl("bucketBaseUrl", target.bucketBaseUrl, issues);
  if (bucketBaseParsed) {
    const host = bucketBaseParsed.hostname;
    const isR2DevSubdomain = /^pub-[0-9a-f]{32}\.r2\.dev$/i.test(host);
    const isCustomDomain = !host.endsWith(".r2.cloudflarestorage.com");
    if (!isR2DevSubdomain && !isCustomDomain) {
      pushIssue(issues, {
        field: "bucketBaseUrl",
        severity: "warning",
        message: "This looks like the R2 API endpoint, not a public URL. Use either https://pub-<hash>.r2.dev (enable in bucket Settings → Public access) or a custom domain you've bound to the bucket."
      });
    }
    if (bucketBaseParsed.pathname && bucketBaseParsed.pathname !== "/") {
      pushIssue(issues, {
        field: "bucketBaseUrl",
        severity: "warning",
        message: "Bucket base URL should be the bucket root (no path)."
      });
    }
  }

  // Viewer URL — must parse.
  validateUrl("viewerUrl", target.viewerUrl, issues);

  // Self-hosted: if token-encrypted is missing but other fields set, warn.
  if (target.selfHosted) {
    const { vercelTokenEncryptedBase64, vercelProjectId } = target.selfHosted;
    if (vercelProjectId && !vercelTokenEncryptedBase64) {
      pushIssue(issues, {
        field: "vercelToken",
        severity: "warning",
        message: "Self-hosted Vercel project ID is set but no API token saved — the in-app deploy action won't work without one."
      });
    }
  }

  return issues;
}

interface NetworkProbeArgs {
  target: PublishTarget;
  /** Optional AbortSignal so long DNS waits don't block the UI for ever. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function probeBucketBaseUrl(args: NetworkProbeArgs): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const url = args.target.bucketBaseUrl.trim();
  if (!url) return issues;
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, { method: "HEAD", signal: args.signal });
    // R2 public bucket roots typically return 404 (no index). Anything 2xx/3xx/4xx
    // means DNS + TLS + the host is reachable. 5xx is a real problem.
    if (response.status >= 500) {
      issues.push({
        field: "bucketBaseUrl",
        severity: "warning",
        message: `Bucket URL responded ${String(response.status)}. Cloudflare or the bucket may be having issues.`
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      field: "bucketBaseUrl",
      severity: "error",
      message: `Could not reach the bucket URL: ${message}. Common causes: typo, missing public access, DNS not resolved.`
    });
  }
  return issues;
}

async function probeR2Credentials(args: NetworkProbeArgs): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const target = args.target;
  const accountId = target.r2.accountId.trim();
  const accessKeyId = target.r2.accessKeyId.trim();
  const secret = target.r2.secretAccessKey;
  const bucket = target.r2.bucket.trim();
  // Only run the live probe when the sync checks would not have already flagged
  // the field as malformed — saves the user a long wait on obvious errors.
  if (!HEX_32.test(accountId) || !accessKeyId || !secret || !bucket || !S3_BUCKET.test(bucket)) {
    return issues;
  }

  const client = new S3Client({
    region: target.r2.region?.trim() || "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey: secret
    }
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    issues.push({
      field: "general",
      severity: "info",
      message: `Verified: HeadBucket on "${bucket}" succeeded.`
    });
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name ?? "Unknown";
    const message = error instanceof Error ? error.message : String(error);
    if (status === 403) {
      issues.push({
        field: "secretAccessKey",
        severity: "error",
        message: "R2 rejected the credentials (403). Re-check the Access Key ID and Secret, and that the token grants Object Read & Write on this bucket."
      });
    } else if (status === 404) {
      issues.push({
        field: "bucket",
        severity: "error",
        message: `Bucket "${bucket}" not found under this account. Check the name and that it lives under this Account ID.`
      });
    } else if (name === "CredentialsProviderError" || /credential/i.test(message)) {
      issues.push({
        field: "secretAccessKey",
        severity: "error",
        message: `Credential error: ${message}`
      });
    } else if (/getaddrinfo|ENOTFOUND|ECONNREFUSED/i.test(message)) {
      issues.push({
        field: "accountId",
        severity: "error",
        message: `Could not resolve https://${accountId}.r2.cloudflarestorage.com — the Account ID is almost certainly wrong (it must be the 32-char hex from your Cloudflare dashboard home page, NOT the bucket name).`
      });
    } else {
      issues.push({
        field: "general",
        severity: "error",
        message: `R2 HeadBucket failed (${String(status ?? "—")}): ${message}`
      });
    }
  }
  return issues;
}

export interface VerifyTargetArgs {
  target: PublishTarget;
  /** Skip the network round-trips (R2 HeadBucket + bucketBaseUrl HEAD). */
  skipNetwork?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Sync format checks first; only run live network probes when the sync layer
 * leaves no errors on the relevant fields. Returns `ok: true` iff there are no
 * `error`-severity issues (warnings/info are advisory).
 */
export async function verifyTarget(args: VerifyTargetArgs): Promise<VerifyTargetResult> {
  const target = args.target;
  const issues: ValidationIssue[] = [];

  for (const issue of validateFormatSync(target)) {
    issues.push(issue);
  }

  if (!args.skipNetwork) {
    const hasFormatError = issues.some((entry) => entry.severity === "error");
    if (!hasFormatError) {
      const [bucketProbe, credProbe] = await Promise.all([
        probeBucketBaseUrl({ target, signal: args.signal, fetchImpl: args.fetchImpl }),
        probeR2Credentials({ target, signal: args.signal, fetchImpl: args.fetchImpl })
      ]);
      for (const issue of bucketProbe) issues.push(issue);
      for (const issue of credProbe) issues.push(issue);
    }
  }

  const ok = !issues.some((entry) => entry.severity === "error");
  return { ok, issues };
}

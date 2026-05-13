/**
 * Vercel Routing Middleware — injects OpenGraph / social-card meta tags
 * into the viewer HTML for `/v/:sha/p/:id` URLs so when a published
 * Simularca URL is shared on Slack / Discord / Twitter / LinkedIn /
 * Facebook the platform's crawler sees the per-publish thumbnail and
 * title instead of a generic page.
 *
 * Flow:
 *   1. Match `/v/<sha>/p/<id>` (the public published-snapshot URL shape).
 *   2. Parse `?b=<bucket>` (the R2 bucket base URL, already required by
 *      the viewer client at runtime).
 *   3. Fetch `${b}/publishes/<id>/latest.json` and follow it to the
 *      manifest, which carries the optional `thumbnail.{url, contentType}`
 *      and `title` fields.
 *   4. Fetch the static `viewer.html` from this same Vercel deployment.
 *   5. Inject `<meta property="og:*">` / `<meta name="twitter:*">` tags
 *      into `<head>` and return the modified HTML.
 *
 * On ANY error (bucket DNS, manifest 404, malformed JSON, missing
 * thumbnail) the middleware falls back to passing the request through
 * unmodified — social cards become a progressive enhancement rather than
 * a hard dependency. The static viewer.html still serves correctly.
 *
 * Security: `?b=<bucket>` is user-supplied so the middleware would
 * otherwise be an SSRF vector. We restrict to `https://` URLs and bound
 * the fetched payload size + a tight timeout. We never expose the manifest
 * body or use it for anything except meta-tag injection.
 */

const PUBLISH_PATH_RE = /^\/v\/([^/]+)\/p\/([^/?#]+)\/?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4000;

interface ManifestLite {
  title?: string;
  publishId?: string;
  thumbnail?: {
    url?: string;
    width?: number;
    height?: number;
    contentType?: string;
  };
}

interface LatestPointerLite {
  manifestUrl?: string;
}

async function fetchWithTimeout(url: string, init?: RequestInit, maxBytes?: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`upstream ${String(response.status)}`);
    }
    const text = await response.text();
    if (maxBytes !== undefined && text.length > maxBytes) {
      throw new Error("upstream payload too large");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function safeBucket(bucket: string | null): string | null {
  if (!bucket) return null;
  let parsed: URL;
  try {
    parsed = new URL(bucket);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // Strip trailing slash for clean joins.
  return bucket.endsWith("/") ? bucket.slice(0, -1) : bucket;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildMetaTags(args: {
  ogImage: string | null;
  ogImageWidth: number | null;
  ogImageHeight: number | null;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
}): string {
  const tags: string[] = [];
  tags.push(`<meta property="og:type" content="website">`);
  tags.push(`<meta property="og:url" content="${escapeHtmlAttr(args.ogUrl)}">`);
  tags.push(`<meta property="og:title" content="${escapeHtmlAttr(args.ogTitle)}">`);
  tags.push(`<meta property="og:description" content="${escapeHtmlAttr(args.ogDescription)}">`);
  tags.push(`<meta name="twitter:card" content="${args.ogImage ? "summary_large_image" : "summary"}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtmlAttr(args.ogTitle)}">`);
  tags.push(`<meta name="twitter:description" content="${escapeHtmlAttr(args.ogDescription)}">`);
  if (args.ogImage) {
    tags.push(`<meta property="og:image" content="${escapeHtmlAttr(args.ogImage)}">`);
    if (args.ogImageWidth) {
      tags.push(`<meta property="og:image:width" content="${String(args.ogImageWidth)}">`);
    }
    if (args.ogImageHeight) {
      tags.push(`<meta property="og:image:height" content="${String(args.ogImageHeight)}">`);
    }
    tags.push(`<meta name="twitter:image" content="${escapeHtmlAttr(args.ogImage)}">`);
  }
  return tags.join("\n    ");
}

function injectIntoHead(html: string, injected: string): string {
  // Insert just before the closing </head>. Case-insensitive match.
  const headCloseMatch = /<\/head>/i.exec(html);
  if (!headCloseMatch) return html;
  const idx = headCloseMatch.index;
  return `${html.slice(0, idx)}    ${injected}\n  ${html.slice(idx)}`;
}

export const config = {
  matcher: "/v/:sha*/p/:id*"
};

export default async function middleware(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const pathMatch = PUBLISH_PATH_RE.exec(requestUrl.pathname);
  if (!pathMatch) {
    return fetch(request);
  }
  const sha = pathMatch[1];
  const publishId = pathMatch[2];
  const bucket = safeBucket(requestUrl.searchParams.get("b"));

  // Compute the upstream viewer.html URL on this same deployment. The
  // rewrite in vercel.json normally turns /v/<sha>/p/<id> into
  // /v/<sha>/viewer.html?p=<id>; we bypass it here and fetch viewer.html
  // ourselves so we can inject meta tags.
  const upstreamHtmlUrl = new URL(`/v/${sha}/viewer.html`, requestUrl.origin).toString();

  // Default to no OG modification if anything below fails.
  const passthrough = (): Promise<Response> => fetch(upstreamHtmlUrl);

  if (!bucket) return passthrough();

  let manifest: ManifestLite | null = null;
  try {
    const latestUrl = `${bucket}/publishes/${encodeURIComponent(publishId)}/latest.json`;
    const latestRaw = await fetchWithTimeout(latestUrl, undefined, MAX_MANIFEST_BYTES);
    const latest = JSON.parse(latestRaw) as LatestPointerLite;
    if (!latest.manifestUrl) throw new Error("missing manifestUrl");
    const manifestUrl = `${bucket}/publishes/${encodeURIComponent(publishId)}/${latest.manifestUrl}`;
    const manifestRaw = await fetchWithTimeout(manifestUrl, undefined, MAX_MANIFEST_BYTES);
    manifest = JSON.parse(manifestRaw) as ManifestLite;
  } catch {
    return passthrough();
  }

  let htmlText: string;
  try {
    htmlText = await fetchWithTimeout(upstreamHtmlUrl, undefined, MAX_HTML_BYTES);
  } catch {
    return passthrough();
  }

  const ogTitle = manifest?.title?.trim() || "Simularca";
  const ogDescription = "Shared via Simularca";
  const ogImage =
    manifest?.thumbnail?.url && manifest.thumbnail.url.trim().length > 0
      ? `${bucket}/${manifest.thumbnail.url.replace(/^\//, "")}`
      : null;
  const meta = buildMetaTags({
    ogTitle,
    ogDescription,
    ogUrl: requestUrl.toString(),
    ogImage,
    ogImageWidth: manifest?.thumbnail?.width ?? null,
    ogImageHeight: manifest?.thumbnail?.height ?? null
  });

  const out = injectIntoHead(htmlText, meta);
  return new Response(out, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Keep the existing immutable cache off for the dynamic-meta path; let
      // the CDN cache for a short while so crawler-spam doesn't melt the
      // function but re-publishes propagate quickly.
      "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=600"
    }
  });
}

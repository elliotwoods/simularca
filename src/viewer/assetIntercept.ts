import type { PublishManifest } from "@/features/publish/publishManifestSchema";

/**
 * The viewer rewrites `simularca-asset://<uuid>/<relativePath>` URLs — which
 * `sceneController` and a few other places hardcode for the Electron asset
 * protocol — to the publish manifest's bucket-resolved URLs.
 *
 * It also wraps every fetch (and XHR load) in a progress accumulator so the
 * viewer's loading overlay can show download speed + bytes-loaded across all
 * in-flight asset fetches.
 *
 * Install this BEFORE any kernel boot so every loader uses the patched
 * fetch/XHR.
 */

const SIMULARCA_ASSET_SCHEME = "simularca-asset://";

interface InstallArgs {
  manifest: PublishManifest;
  bucketBaseUrl: string;
}

export interface AssetProgressEntry {
  id: number;
  url: string;
  fileName: string;
  loadedBytes: number;
  totalBytes: number | null;
  startedAtMs: number;
  /** Bytes / second observed in the last sampling window. */
  bytesPerSecond: number;
  done: boolean;
  errored: boolean;
}

export interface AssetProgressSnapshot {
  inFlight: AssetProgressEntry[];
  totalLoadedBytes: number;
  totalKnownBytes: number;
  aggregateBytesPerSecond: number;
}

const listeners = new Set<(snapshot: AssetProgressSnapshot) => void>();
const entriesById = new Map<number, AssetProgressEntry>();
let nextId = 1;

let manifestRef: PublishManifest | null = null;
let bucketBaseUrlRef: string = "";

const SAMPLE_WINDOW_MS = 750;
const SPEED_HISTORY = new Map<number, { tsMs: number; loaded: number }[]>();

function emit(): void {
  const snapshot = buildSnapshot();
  for (const listener of listeners) listener(snapshot);
}

function buildSnapshot(): AssetProgressSnapshot {
  let totalLoaded = 0;
  let totalKnown = 0;
  let aggregateBps = 0;
  const inFlight: AssetProgressEntry[] = [];
  for (const entry of entriesById.values()) {
    totalLoaded += entry.loadedBytes;
    if (entry.totalBytes != null) totalKnown += entry.totalBytes;
    if (!entry.done && !entry.errored) {
      aggregateBps += entry.bytesPerSecond;
      inFlight.push(entry);
    }
  }
  return {
    inFlight,
    totalLoadedBytes: totalLoaded,
    totalKnownBytes: totalKnown,
    aggregateBytesPerSecond: aggregateBps
  };
}

function updateRate(entry: AssetProgressEntry): void {
  const now = Date.now();
  const history = SPEED_HISTORY.get(entry.id) ?? [];
  history.push({ tsMs: now, loaded: entry.loadedBytes });
  // Drop samples older than SAMPLE_WINDOW_MS.
  while (history.length > 0 && now - history[0]!.tsMs > SAMPLE_WINDOW_MS) {
    history.shift();
  }
  SPEED_HISTORY.set(entry.id, history);
  if (history.length >= 2) {
    const first = history[0]!;
    const last = history[history.length - 1]!;
    const dtMs = last.tsMs - first.tsMs;
    const dBytes = last.loaded - first.loaded;
    entry.bytesPerSecond = dtMs > 0 ? (dBytes * 1000) / dtMs : 0;
  } else {
    const dtMs = Math.max(1, now - entry.startedAtMs);
    entry.bytesPerSecond = (entry.loadedBytes * 1000) / dtMs;
  }
}

function logEvent(message: string): void {
  // Surfacing fetch lifecycle to console makes headless smoke logs useful;
  // the floating overlay shows the same info in a real browser.
  // eslint-disable-next-line no-console
  console.info(`[asset] ${message}`);
}

function startEntry(url: string, totalHint: number | null): AssetProgressEntry {
  const entry: AssetProgressEntry = {
    id: nextId++,
    url,
    fileName: fileNameFromUrl(url),
    loadedBytes: 0,
    totalBytes: totalHint,
    startedAtMs: Date.now(),
    bytesPerSecond: 0,
    done: false,
    errored: false
  };
  entriesById.set(entry.id, entry);
  SPEED_HISTORY.set(entry.id, []);
  logEvent(`start ${entry.fileName} (${totalHint ? `${(totalHint / 1024 / 1024).toFixed(1)} MB` : "unknown size"})`);
  emit();
  return entry;
}

function reportProgress(entry: AssetProgressEntry, loadedBytes: number, totalBytes: number | null): void {
  entry.loadedBytes = loadedBytes;
  if (totalBytes != null) entry.totalBytes = totalBytes;
  updateRate(entry);
  emit();
}

function finishEntry(entry: AssetProgressEntry, errored = false): void {
  entry.done = !errored;
  entry.errored = errored;
  updateRate(entry);
  const elapsedSec = Math.max(0.001, (Date.now() - entry.startedAtMs) / 1000);
  const mbps = entry.loadedBytes / 1024 / 1024 / elapsedSec;
  logEvent(
    `${errored ? "ERR" : "ok"} ${entry.fileName} (${(entry.loadedBytes / 1024 / 1024).toFixed(1)} MB in ${elapsedSec.toFixed(1)}s, ${mbps.toFixed(1)} MB/s)`
  );
  emit();
  // Drop the entry from the active list after a short delay so the UI can
  // animate it away. We don't keep history around in-memory long-term.
  setTimeout(() => {
    entriesById.delete(entry.id);
    SPEED_HISTORY.delete(entry.id);
    emit();
  }, 1500);
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://x");
    const segments = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? url);
  } catch {
    return url;
  }
}

function rewriteSimularcaAsset(url: string): string {
  if (!manifestRef) return url;
  if (!url.startsWith(SIMULARCA_ASSET_SCHEME)) return url;
  // Parse "simularca-asset://<uuid>/<encoded relativePath>". URL.parse can't
  // handle custom schemes uniformly, so do it manually.
  const rest = url.slice(SIMULARCA_ASSET_SCHEME.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 0) return url;
  const uuid = decodeURIComponent(rest.slice(0, slashIdx));
  const encodedPath = rest.slice(slashIdx + 1);
  const relativePath = encodedPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  const key = `${uuid}/${relativePath}`;
  const bucketKey = manifestRef.assets[key];
  if (!bucketKey) {
    // No mapping — the manifest is missing this asset. Leave the URL alone
    // so the caller sees a clear failure rather than a silent rewrite.
    // eslint-disable-next-line no-console
    console.warn(`[viewer] No manifest mapping for asset: ${key}`);
    return url;
  }
  const base = bucketBaseUrlRef.endsWith("/") ? bucketBaseUrlRef.slice(0, -1) : bucketBaseUrlRef;
  return `${base}/${bucketKey.startsWith("/") ? bucketKey.slice(1) : bucketKey}`;
}

function shouldTrackProgress(url: string): boolean {
  // Track http(s) fetches of bucket assets (i.e. the heavy stuff).
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url.includes("/assets/") || url.includes(".fbx") || url.includes(".gltf") || url.includes(".glb") || url.includes(".ktx2") || url.includes(".hdr") || url.includes(".exr") || url.includes(".dae") || url.includes(".dxf");
  }
  return false;
}

function installFetchInterceptor(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    let request: Request | null = null;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      request = input;
      url = input.url;
    }
    const rewritten = rewriteSimularcaAsset(url);
    if (rewritten !== url) {
      // Re-issue against the new URL.
      url = rewritten;
      request = null;
    }
    if (!shouldTrackProgress(url)) {
      return request ? originalFetch(request, init) : originalFetch(url, init);
    }
    const response = await (request ? originalFetch(request, init) : originalFetch(url, init));
    if (!response.body || !response.ok) {
      return response;
    }
    const totalHeader = response.headers.get("content-length");
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
    const entry = startEntry(url, Number.isFinite(total) ? total : null);
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let loaded = 0;
        function pump(): Promise<void> {
          return reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                finishEntry(entry, false);
                controller.close();
                return;
              }
              if (value) {
                loaded += value.byteLength;
                reportProgress(entry, loaded, total);
                controller.enqueue(value);
              }
              return pump();
            })
            .catch((reason) => {
              finishEntry(entry, true);
              controller.error(reason);
            });
        }
        void pump();
      },
      cancel(reason) {
        finishEntry(entry, true);
        return reader.cancel(reason);
      }
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

function installImageSrcInterceptor(): void {
  // Three.js's TextureLoader uses `new Image()` and sets `.src` — those
  // requests don't go through fetch or XHR, so we patch the prototype
  // accessor to rewrite simularca-asset:// URLs before the browser dispatches
  // the request.
  const proto = HTMLImageElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "src");
  if (!desc || !desc.set || !desc.get) return;
  const originalSet = desc.set;
  const originalGet = desc.get;
  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: desc.enumerable ?? true,
    get(this: HTMLImageElement): string {
      return originalGet.call(this) as string;
    },
    set(this: HTMLImageElement, value: string): void {
      const rewritten = typeof value === "string" ? rewriteSimularcaAsset(value) : value;
      originalSet.call(this, rewritten);
    }
  });

  // <img>'s setAttribute('src', ...) goes through the same setter when modern
  // (per spec), but defensively patch setAttribute on Element for the few
  // engines that bypass the setter. Cheap to add.
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name: string, value: string): void {
    if ((name === "src" || name === "href") && typeof value === "string") {
      value = rewriteSimularcaAsset(value);
    }
    return originalSetAttribute.call(this, name, value);
  };
}

function installXhrInterceptor(): void {
  const OriginalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    ...args: unknown[]
  ): void {
    if (typeof args[1] === "string") {
      args[1] = rewriteSimularcaAsset(args[1]);
    } else if (args[1] instanceof URL) {
      args[1] = rewriteSimularcaAsset(args[1].toString());
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (OriginalOpen as any).apply(this, args);
  } as typeof OriginalOpen;
}

export function installAssetIntercept(args: InstallArgs): () => void {
  manifestRef = args.manifest;
  bucketBaseUrlRef = args.bucketBaseUrl;
  installFetchInterceptor();
  installXhrInterceptor();
  installImageSrcInterceptor();
  return () => {
    manifestRef = null;
    bucketBaseUrlRef = "";
  };
}

export function subscribeAssetProgress(listener: (snapshot: AssetProgressSnapshot) => void): () => void {
  listeners.add(listener);
  // Push current snapshot so subscribers don't wait for the first event.
  listener(buildSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

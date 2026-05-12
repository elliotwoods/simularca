import ReactDOM from "react-dom/client";
import * as THREE from "three";
import * as THREE_TSL from "three/tsl";
import * as THREE_WEBGPU from "three/webgpu";
import "flexlayout-react/style/dark.css";
import "@/styles.css";
import { createViewerKernel, type AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { registerCoreActorDescriptors } from "@/features/actors/registerCoreActors";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";
import { installAssetIntercept } from "@/viewer/assetIntercept";

// Expose the host viewer's three.js instances so plugin bundles can share
// them. Plugins are bundled with a virtual-three esbuild plugin (see
// `electron/pluginBundler.ts`) that resolves imports of `three`, `three/tsl`,
// and `three/webgpu` to these globals rather than per-plugin copies. Without
// this, `instanceof THREE.Object3D` checks in plugins fail against host
// objects (beam emitter, cross-section, etc.) AND TSL functions used in
// plugin shaders see different identities than the host renderer.
(globalThis as { __simularca_shared__?: Record<string, unknown> }).__simularca_shared__ = {
  three: THREE,
  "three/tsl": THREE_TSL,
  "three/webgpu": THREE_WEBGPU
};
import {
  parseLatestPointer,
  parsePublishManifest,
  type PublishManifest
} from "@/features/publish/publishManifestSchema";
import {
  defaultPublishConfig,
  parsePublishConfig,
  type PublishConfig
} from "@/features/publish/publishConfigSchema";
import { ViewerApp } from "@/viewer/ViewerApp";
import type { WebStorageAdapterOptions } from "@/features/storage/webStorageAdapter";

const VIEWER_LOG_PREFIX = "[viewer]";

function log(message: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.info(`${VIEWER_LOG_PREFIX} ${message}`, ...rest);
}

function fatal(message: string, error?: unknown): never {
  const detail =
    error instanceof Error ? error.message : typeof error === "string" ? error : error ? JSON.stringify(error) : "";
  // eslint-disable-next-line no-console
  console.error(`${VIEWER_LOG_PREFIX} FATAL: ${message}`, error);
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<div style="font-family: ui-sans-serif, system-ui; padding: 32px; color: #f0f0f0; background: #0d0f12; min-height: 100vh;">
      <h1 style="margin: 0 0 12px; font-size: 18px;">Viewer failed to start</h1>
      <p style="margin: 0 0 8px; opacity: 0.85;">${escapeHtml(message)}</p>
      ${detail ? `<pre style="white-space: pre-wrap; opacity: 0.7; font-size: 12px;">${escapeHtml(detail)}</pre>` : ""}
    </div>`;
  }
  throw error instanceof Error ? error : new Error(message);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface FetchManifestArgs {
  bucketBaseUrl: string;
  publishId: string;
}

async function fetchManifestViaLatest(args: FetchManifestArgs): Promise<{
  manifest: PublishManifest;
  publishConfig: PublishConfig;
}> {
  const { bucketBaseUrl, publishId } = args;
  const base = bucketBaseUrl.endsWith("/") ? bucketBaseUrl.slice(0, -1) : bucketBaseUrl;
  const latestUrl = `${base}/publishes/${publishId}/latest.json`;

  const latestResponse = await fetch(latestUrl, { cache: "no-store" });
  if (!latestResponse.ok) {
    throw new Error(
      `Failed to fetch publish pointer at ${latestUrl}: ${String(latestResponse.status)} ${latestResponse.statusText}. ` +
        `(Common cause: R2 bucket CORS not configured for this origin.)`
    );
  }
  const latest = parseLatestPointer(await latestResponse.text());

  const manifestUrl = `${base}/publishes/${encodeURIComponent(publishId)}/${latest.manifestUrl}`;
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`Failed to fetch manifest at ${manifestUrl}: ${String(manifestResponse.status)} ${manifestResponse.statusText}`);
  }
  const manifest = parsePublishManifest(await manifestResponse.text());

  // manifest.publishConfigUrl is bucket-relative (e.g. `publishes/<id>/publishConfig-<sha>.json`).
  const publishConfigUrl = `${base}/${manifest.publishConfigUrl}`;
  const publishConfigResponse = await fetch(publishConfigUrl);
  let publishConfig: PublishConfig;
  if (publishConfigResponse.ok) {
    try {
      publishConfig = parsePublishConfig(await publishConfigResponse.text());
    } catch (error) {
      log("publishConfig parse failed; falling back to defaults", error);
      publishConfig = defaultPublishConfig();
    }
  } else {
    log(
      `publishConfig fetch returned ${String(publishConfigResponse.status)}; falling back to defaults`
    );
    publishConfig = defaultPublishConfig();
  }
  return { manifest, publishConfig };
}

interface DevManifestPayload {
  manifest: PublishManifest;
  publishConfig: PublishConfig;
  bucketBaseUrl: string;
}

async function fetchDevManifestPayload(devManifestUrl: string): Promise<DevManifestPayload> {
  const response = await fetch(devManifestUrl);
  if (!response.ok) {
    throw new Error(`Dev manifest fetch failed: ${String(response.status)} ${response.statusText}`);
  }
  const raw = (await response.json()) as {
    manifest: unknown;
    publishConfig?: unknown;
    bucketBaseUrl: string;
  };
  const manifest = parsePublishManifest(JSON.stringify(raw.manifest));
  const publishConfig = raw.publishConfig
    ? parsePublishConfig(JSON.stringify(raw.publishConfig))
    : defaultPublishConfig();
  if (!raw.bucketBaseUrl) {
    throw new Error("Dev manifest payload is missing `bucketBaseUrl`.");
  }
  return { manifest, publishConfig, bucketBaseUrl: raw.bucketBaseUrl };
}

async function loadPluginsForViewer(kernel: AppKernel, manifest: PublishManifest, bucketBaseUrl: string): Promise<void> {
  if (manifest.plugins.length === 0) {
    return;
  }
  const base = bucketBaseUrl.endsWith("/") ? bucketBaseUrl.slice(0, -1) : bucketBaseUrl;
  for (const entry of manifest.plugins) {
    const url = `${base}/${entry.url.startsWith("/") ? entry.url.slice(1) : entry.url}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Plugin fetch ${String(response.status)} ${response.statusText}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      try {
        await loadPluginFromModule(
          kernel,
          blobUrl,
          {
            sourceGroup: "plugins-external",
            version: entry.version,
            expectedExternals: entry.externals
          }
        );
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`${VIEWER_LOG_PREFIX} Failed to load plugin ${entry.id}@${entry.version}: ${detail}`);
      kernel.store.getState().actions.addLog({
        level: "error",
        message: `Failed to load plugin ${entry.id}@${entry.version}`,
        details: detail
      });
    }
  }
}

async function main(): Promise<void> {
  // Stash the viewer's bundled externals so the plugin loader can major-
  // version-check incoming plugin bundles. Vite's `define` replaces the bare
  // identifier with the JSON literal at build time.
  (globalThis as { __SIMULARCA_VIEWER_EXTERNALS__?: Record<string, string> })
    .__SIMULARCA_VIEWER_EXTERNALS__ = __SIMULARCA_VIEWER_EXTERNALS__;

  const params = new URLSearchParams(window.location.search);
  // The canonical published URL is /v/<sha>/p/<id>?b=<bucket>. Vercel rewrites
  // that to /v/<sha>/viewer.html server-side, but the browser's location.search
  // only sees the original query — server-side destination params don't reach
  // the JS. So extract publishId from the pathname first, fall back to ?p=.
  const pathMatch = /\/v\/[^/]+\/p\/([^/?#]+)/.exec(window.location.pathname);
  const publishId = pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : params.get("p");
  const bucketBaseUrlParam = params.get("b");

  let manifest: PublishManifest;
  let publishConfig: PublishConfig;
  let bucketBaseUrl: string;

  // Build-time-gated dev escape: load a hand-crafted manifest from
  // /public/dev-publish/ for local smoke-testing without touching R2.
  // `import.meta.env.DEV` is statically replaced and DCE'd in production.
  if (import.meta.env.DEV) {
    const devManifestUrl = params.get("manifest");
    if (devManifestUrl) {
      log(`Loading dev manifest payload from ${devManifestUrl}`);
      try {
        const payload = await fetchDevManifestPayload(devManifestUrl);
        manifest = payload.manifest;
        publishConfig = payload.publishConfig;
        bucketBaseUrl = payload.bucketBaseUrl;
      } catch (error) {
        fatal(`Dev manifest load failed.`, error);
      }
    } else if (publishId && bucketBaseUrlParam) {
      const fetched = await fetchManifestViaLatest({ publishId, bucketBaseUrl: bucketBaseUrlParam });
      manifest = fetched.manifest;
      publishConfig = fetched.publishConfig;
      bucketBaseUrl = bucketBaseUrlParam;
    } else {
      fatal("Viewer requires either `?p=<publishId>&b=<bucketBaseUrl>` or (dev only) `?manifest=<url>`.");
    }
  } else {
    if (!publishId || !bucketBaseUrlParam) {
      fatal("Viewer requires `?p=<publishId>&b=<bucketBaseUrl>` query parameters.");
    }
    const fetched = await fetchManifestViaLatest({ publishId, bucketBaseUrl: bucketBaseUrlParam });
    manifest = fetched.manifest;
    publishConfig = fetched.publishConfig;
    bucketBaseUrl = bucketBaseUrlParam;
  }

  const webStorageOptions: WebStorageAdapterOptions = { manifest, bucketBaseUrl };
  // Patch fetch + XHR before anything in the kernel can use them: rewrites
  // `simularca-asset://` URLs (which `sceneController` hardcodes for the
  // Electron protocol) to bucket URLs, and tracks download progress for the
  // loading overlay.
  installAssetIntercept({ manifest, bucketBaseUrl });
  const kernel = createViewerKernel({ webStorageOptions, viewerConfig: publishConfig });

  registerCoreActorDescriptors(kernel);

  await loadPluginsForViewer(kernel, manifest, bucketBaseUrl);

  // Hydrate the active project from the manifest. The web adapter's
  // `openProject` validates that the requested path matches the manifest's
  // project uuid, so passing the uuid is correct (identity-bridging contract).
  try {
    await kernel.projectService.openProject(manifest.project.uuid, null);
  } catch (error) {
    fatal("Failed to load published snapshot.", error);
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <KernelProvider kernel={kernel}>
      <ViewerApp publishConfig={publishConfig} manifest={manifest} />
    </KernelProvider>
  );

  log(
    `Viewer ready. publishId=${manifest.publishId} project=${manifest.project.name} snapshots=${String(manifest.snapshots.length)}`
  );
}

void main();

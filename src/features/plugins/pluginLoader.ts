import { PLUGIN_HANDSHAKE_VERSION, isPluginHandshakeModule, type PluginLoaderResult } from "./contracts";
import { augmentInternalPluginDefinition } from "./internalPluginAugmentations";
import type { AppKernel } from "@/app/kernel";

export interface PluginLoadSource {
  sourceGroup?: "plugins-external" | "plugins" | "manual";
  updatedAtMs?: number;
  version?: string;
  /**
   * Externals declared by the plugin bundle (only populated for plugins
   * loaded from publish manifests in the viewer). Compared against the
   * viewer's bundled versions; major mismatches refuse to load, minor
   * mismatches warn.
   */
  expectedExternals?: Record<string, string>;
}

export interface PluginLoadOptions {
  cacheBustToken?: string | number;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(value: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function readViewerExternals(): Record<string, string> {
  // Viewer entry stashes its own externals on globalThis at boot. In editor
  // contexts the global is undefined and the externals check is a no-op.
  const value = (globalThis as { __SIMULARCA_VIEWER_EXTERNALS__?: Record<string, string> })
    .__SIMULARCA_VIEWER_EXTERNALS__;
  return value ?? {};
}

function assertCompatibleExternals(
  expected: Record<string, string>,
  modulePath: string
): void {
  const viewerVersions = readViewerExternals();
  if (Object.keys(viewerVersions).length === 0) {
    // Editor context (or plain browser without the global). Skip silently.
    return;
  }
  for (const [packageName, expectedVersion] of Object.entries(expected)) {
    const actualVersion = viewerVersions[packageName];
    if (!actualVersion) {
      // Plugin asked for a package the viewer doesn't bundle. Treat as a
      // major mismatch — refuse the load.
      throw new Error(
        `Plugin ${modulePath} expects external "${packageName}@${expectedVersion}" but the viewer does not bundle "${packageName}".`
      );
    }
    const expectedSemver = parseSemver(expectedVersion);
    const actualSemver = parseSemver(actualVersion);
    if (!expectedSemver || !actualSemver) {
      // Non-semver version strings — fall back to exact match.
      if (expectedVersion !== actualVersion) {
        // eslint-disable-next-line no-console
        console.warn(
          `Plugin ${modulePath}: external "${packageName}" version "${actualVersion}" differs from expected "${expectedVersion}" (non-semver; cannot compare ranges).`
        );
      }
      continue;
    }
    if (expectedSemver.major !== actualSemver.major) {
      throw new Error(
        `Plugin ${modulePath} requires "${packageName}@${expectedVersion}" but the viewer bundles "${actualVersion}". Major version mismatch is incompatible.`
      );
    }
    if (
      expectedSemver.minor !== actualSemver.minor ||
      expectedSemver.patch !== actualSemver.patch
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `Plugin ${modulePath}: external "${packageName}" loaded as "${actualVersion}", plugin was built against "${expectedVersion}".`
      );
    }
  }
}

function shouldNormalizeFileUrlForDev(runtimeProtocol?: string): boolean {
  if (runtimeProtocol) {
    return runtimeProtocol === "http:" || runtimeProtocol === "https:";
  }
  if (typeof window === "undefined") {
    return false;
  }
  const protocol = window.location?.protocol;
  return protocol === "http:" || protocol === "https:";
}

function normalizeWindowsDrivePath(pathname: string): string {
  if (/^\/[A-Za-z]:\//.test(pathname)) {
    return pathname.slice(1);
  }
  return pathname;
}

function appendCacheBust(specifier: string, cacheBustToken?: string | number): string {
  if (cacheBustToken === undefined || cacheBustToken === null || cacheBustToken === "") {
    return specifier;
  }
  const separator = specifier.includes("?") ? "&" : "?";
  return `${specifier}${separator}v=${encodeURIComponent(String(cacheBustToken))}`;
}

export function resolvePluginModuleSpecifier(
  modulePath: string,
  runtimeProtocol?: string,
  cacheBustToken?: string | number
): string {
  if (!shouldNormalizeFileUrlForDev(runtimeProtocol)) {
    return appendCacheBust(modulePath, cacheBustToken);
  }
  let parsed: URL;
  try {
    parsed = new URL(modulePath);
  } catch {
    return appendCacheBust(modulePath, cacheBustToken);
  }
  if (parsed.protocol !== "file:") {
    return appendCacheBust(modulePath, cacheBustToken);
  }
  const pathname = normalizeWindowsDrivePath(decodeURIComponent(parsed.pathname));
  return appendCacheBust(`/@fs/${pathname}`, cacheBustToken);
}

function assertCompatibleHandshake(handshakeVersion: number, modulePath: string): void {
  if (handshakeVersion !== PLUGIN_HANDSHAKE_VERSION) {
    throw new Error(
      `Plugin handshake mismatch for ${modulePath}: expected ${PLUGIN_HANDSHAKE_VERSION}, received ${String(handshakeVersion)}.`
    );
  }
}

function assertCompatibleEngine(
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  },
  modulePath: string
): void {
  const apiVersion = PLUGIN_HANDSHAKE_VERSION;
  if (apiVersion < engine.minApiVersion || apiVersion > engine.maxApiVersion) {
    throw new Error(
      `Plugin API range mismatch for ${modulePath}: engine expects ${engine.minApiVersion}-${engine.maxApiVersion}, runtime is ${apiVersion}.`
    );
  }
}

export function applyPluginVersionOverride<T extends { version: string }>(manifest: T, versionOverride?: string): T {
  if (!versionOverride) {
    return manifest;
  }
  return {
    ...manifest,
    version: versionOverride
  };
}

export async function loadPluginFromModule(
  kernel: AppKernel,
  modulePath: string,
  source?: PluginLoadSource,
  options?: PluginLoadOptions
): Promise<PluginLoaderResult> {
  if (source?.expectedExternals) {
    assertCompatibleExternals(source.expectedExternals, modulePath);
  }
  const importSpecifier = resolvePluginModuleSpecifier(modulePath, undefined, options?.cacheBustToken);
  const module = (await import(/* @vite-ignore */ importSpecifier)) as {
    default?: unknown;
    handshake?: unknown;
  };

  const candidate = isPluginHandshakeModule(module.default)
    ? module.default
    : isPluginHandshakeModule(module.handshake)
      ? module.handshake
      : null;

  if (!candidate) {
    throw new Error(
      `Plugin module ${modulePath} does not export a valid handshake object. Expected default or 'handshake' export.`
    );
  }

  assertCompatibleHandshake(candidate.manifest.handshakeVersion, modulePath);
  assertCompatibleEngine(candidate.manifest.engine, modulePath);

  const manifest = applyPluginVersionOverride(candidate.manifest, source?.version);
  const plugin = augmentInternalPluginDefinition(manifest.id, candidate.createPlugin());
  const registration = kernel.pluginApi.registerPlugin(plugin, manifest, {
    modulePath,
    sourceGroup: source?.sourceGroup ?? "manual",
    loadedAtIso: new Date().toISOString(),
    updatedAtMs: source?.updatedAtMs
  });
  return {
    manifest,
    plugin: registration.plugin.definition
  };
}

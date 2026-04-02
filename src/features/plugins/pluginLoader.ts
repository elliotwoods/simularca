import { PLUGIN_HANDSHAKE_VERSION, isPluginHandshakeModule, type PluginLoaderResult } from "./contracts";
import { augmentInternalPluginDefinition } from "./internalPluginAugmentations";
import type { AppKernel } from "@/app/kernel";

export interface PluginLoadSource {
  sourceGroup?: "plugins-external" | "plugins" | "manual";
  updatedAtMs?: number;
  version?: string;
}

export interface PluginLoadOptions {
  cacheBustToken?: string | number;
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

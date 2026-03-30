import type { PluginDefinition, PluginDefinitionInput } from "./pluginApi";

export const PLUGIN_HANDSHAKE_VERSION = 1;

export interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  };
}

export interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinitionInput;
}

export interface PluginLoaderResult {
  manifest: PluginManifest;
  plugin: PluginDefinition;
}

export function isPluginHandshakeModule(input: unknown): input is PluginHandshakeModule {
  if (!input || typeof input !== "object") {
    return false;
  }
  const candidate = input as Partial<PluginHandshakeModule>;
  return Boolean(
    candidate.manifest &&
      typeof candidate.createPlugin === "function" &&
      typeof candidate.manifest.id === "string" &&
      typeof candidate.manifest.name === "string"
  );
}


import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: [];
  componentDescriptors: [];
  viewDescriptors: [];
}

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
  createPlugin(): PluginDefinition;
}

export function createRotoControlPlugin(): PluginDefinition {
  return {
    id: "plugin.rotoControl",
    name: "Roto-Control",
    actorDescriptors: [],
    componentDescriptors: [],
    viewDescriptors: []
  };
}

const handshake = {
  manifest: {
    handshakeVersion: 1,
    id: "plugin.rotoControl",
    name: "Roto-Control",
    version: PLUGIN_VERSION,
    description: "App-wide Melbourne Instruments Roto-Control integration.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return createRotoControlPlugin();
  }
} satisfies PluginHandshakeModule;

export { handshake };
export default handshake;

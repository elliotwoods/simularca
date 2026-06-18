import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";
import type { PluginDefinition, PluginHandshakeModule } from "./pluginContracts";
import { source4Descriptor } from "./source4Descriptor";

const PLUGIN_ID = "plugin.theatre-lights";

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: PLUGIN_ID,
    name: "Theatre Lights",
    version: PLUGIN_VERSION,
    description: "Theatre-lighting fixtures. v1: ETC Source Four (wireframe visualisation).",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin(): PluginDefinition {
    return {
      id: PLUGIN_ID,
      name: "Theatre Lights",
      actorDescriptors: [source4Descriptor],
      componentDescriptors: []
    };
  }
};

export { handshake };
export default handshake;

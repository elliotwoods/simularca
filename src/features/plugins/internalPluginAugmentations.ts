import type { PluginDefinitionInput } from "./pluginApi";
import { augmentRotoControlPluginDefinition } from "@/features/rotoControl/rotoControlPlugin";

export function augmentInternalPluginDefinition(pluginId: string, plugin: PluginDefinitionInput): PluginDefinitionInput {
  if (pluginId === "plugin.rotoControl") {
    return augmentRotoControlPluginDefinition(plugin);
  }
  return plugin;
}

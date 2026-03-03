import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import type { PluginManifest } from "./contracts";

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
}

export interface RegisteredPlugin {
  definition: PluginDefinition;
  manifest?: PluginManifest;
  source?: {
    modulePath: string;
    sourceGroup?: "plugins-local" | "plugins" | "manual";
    loadedAtIso: string;
  };
}

export interface PluginApi {
  registerPlugin(
    plugin: PluginDefinition,
    manifest?: PluginManifest,
    source?: RegisteredPlugin["source"]
  ): { registered: boolean; plugin: RegisteredPlugin };
  listPlugins(): RegisteredPlugin[];
  registerActorType(descriptor: ReloadableDescriptor): void;
  registerComponentType(descriptor: ReloadableDescriptor): void;
}

export function createPluginApi(registry: DescriptorRegistry): PluginApi {
  const plugins = new Map<string, RegisteredPlugin>();

  return {
    registerPlugin(plugin, manifest, source) {
      const existing = plugins.get(plugin.id);
      if (existing) {
        return {
          registered: false,
          plugin: existing
        };
      }
      const registeredPlugin: RegisteredPlugin = { definition: plugin, manifest, source };
      plugins.set(plugin.id, registeredPlugin);
      for (const descriptor of plugin.actorDescriptors) {
        registry.register(descriptor);
      }
      for (const descriptor of plugin.componentDescriptors) {
        registry.register(descriptor);
      }
      return {
        registered: true,
        plugin: registeredPlugin
      };
    },
    listPlugins() {
      return [...plugins.values()];
    },
    registerActorType(descriptor) {
      registry.register(descriptor);
    },
    registerComponentType(descriptor) {
      registry.register(descriptor);
    }
  };
}

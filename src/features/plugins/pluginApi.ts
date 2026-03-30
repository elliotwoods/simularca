import type { ReactNode, ComponentType } from "react";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import type { HotReloadManager } from "@/core/hotReload/hotReloadManager";
import type { ActorNode, ActorRuntimeStatus, ParameterValues, PluginViewState } from "@/core/types";
import type { PluginManifest } from "./contracts";

export interface PluginViewActions {
  updateActorParams(partial: ParameterValues): void;
  openSiblingView(viewType: string): void;
  focusView(viewId: string): void;
  closeView(viewId: string): void;
}

export interface PluginViewComponentProps {
  pluginView: PluginViewState;
  actor: ActorNode | null;
  runtimeStatus: ActorRuntimeStatus | null;
  actions: PluginViewActions;
}

export interface PluginViewDescriptor {
  viewType: string;
  title: string;
  component?: ComponentType<PluginViewComponentProps>;
  render?: (props: PluginViewComponentProps) => ReactNode;
}

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
  viewDescriptors: PluginViewDescriptor[];
}

export interface PluginDefinitionInput {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
  viewDescriptors?: PluginViewDescriptor[];
}

export interface RegisteredPlugin {
  definition: PluginDefinition;
  manifest?: PluginManifest;
  source?: {
    modulePath: string;
    sourceGroup?: "plugins-local" | "plugins" | "manual";
    loadedAtIso: string;
    updatedAtMs?: number;
  };
  lastLoadedAtIso: string;
  reloadCount: number;
}

export interface PluginRegistrationResult {
  action: "added" | "reloaded";
  plugin: RegisteredPlugin;
}

export interface PluginApi {
  registerPlugin(
    plugin: PluginDefinitionInput,
    manifest?: PluginManifest,
    source?: RegisteredPlugin["source"]
  ): PluginRegistrationResult;
  listPlugins(): RegisteredPlugin[];
  getPluginByModulePath(modulePath: string): RegisteredPlugin | null;
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  registerActorType(descriptor: ReloadableDescriptor): void;
  registerComponentType(descriptor: ReloadableDescriptor): void;
  getViewDescriptor(pluginId: string, viewType: string): PluginViewDescriptor | null;
}

function normalizePluginDefinition(plugin: PluginDefinitionInput): PluginDefinition {
  return {
    ...plugin,
    viewDescriptors: [...(plugin.viewDescriptors ?? [])]
  };
}

function validateViewDescriptors(plugin: PluginDefinition): void {
  const seen = new Set<string>();
  for (const descriptor of plugin.viewDescriptors) {
    if (!descriptor.viewType.trim()) {
      throw new Error(`Plugin ${plugin.id} has a view descriptor with an empty viewType.`);
    }
    const key = descriptor.viewType;
    if (seen.has(key)) {
      throw new Error(`Plugin ${plugin.id} declares duplicate view descriptor ${key}.`);
    }
    seen.add(key);
  }
}

export function createPluginApi(registry: DescriptorRegistry, hotReloadManager: HotReloadManager): PluginApi {
  const plugins = new Map<string, RegisteredPlugin>();
  const listeners = new Set<() => void>();
  let revision = 0;

  const emit = () => {
    revision += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    registerPlugin(plugin, manifest, source) {
      const normalizedPlugin = normalizePluginDefinition(plugin);
      validateViewDescriptors(normalizedPlugin);
      const existing = plugins.get(normalizedPlugin.id);
      const loadedAtIso = new Date().toISOString();
      const registeredPlugin: RegisteredPlugin = {
        definition: normalizedPlugin,
        manifest,
        source: source
          ? {
              ...source,
              loadedAtIso
            }
          : undefined,
        lastLoadedAtIso: loadedAtIso,
        reloadCount: existing ? existing.reloadCount + 1 : 0
      };
      if (existing) {
        const applied = hotReloadManager.applyDescriptorSetUpdate(
          source?.modulePath ?? `plugin:${normalizedPlugin.id}`,
          [
            ...existing.definition.actorDescriptors.map((descriptor) => descriptor.id),
            ...existing.definition.componentDescriptors.map((descriptor) => descriptor.id)
          ],
          [
          ...normalizedPlugin.actorDescriptors,
          ...normalizedPlugin.componentDescriptors
          ]
        );
        if (!applied) {
          return {
            action: "reloaded",
            plugin: existing
          };
        }
        plugins.set(plugin.id, registeredPlugin);
        emit();
        return {
          action: "reloaded",
          plugin: registeredPlugin
        };
      }
      plugins.set(normalizedPlugin.id, registeredPlugin);
      for (const descriptor of normalizedPlugin.actorDescriptors) {
        registry.register(descriptor);
      }
      for (const descriptor of normalizedPlugin.componentDescriptors) {
        registry.register(descriptor);
      }
      emit();
      return {
        action: "added",
        plugin: registeredPlugin
      };
    },
    listPlugins() {
      return [...plugins.values()];
    },
    getPluginByModulePath(modulePath) {
      for (const entry of plugins.values()) {
        if (entry.source?.modulePath === modulePath) {
          return entry;
        }
      }
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRevision() {
      return revision;
    },
    registerActorType(descriptor) {
      registry.register(descriptor);
      emit();
    },
    registerComponentType(descriptor) {
      registry.register(descriptor);
      emit();
    },
    getViewDescriptor(pluginId, viewType) {
      return plugins.get(pluginId)?.definition.viewDescriptors.find((descriptor) => descriptor.viewType === viewType) ?? null;
    }
  };
}

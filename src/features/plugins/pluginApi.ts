import type { ReactNode, ComponentType } from "react";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import type { HotReloadManager } from "@/core/hotReload/hotReloadManager";
import type {
  ActorNode,
  ActorRuntimeStatus,
  ActorVisibilityMode,
  ParameterSchema,
  ParameterValues,
  PluginViewState,
  TransformTRS
} from "@/core/types";
import type { PluginManifest } from "./contracts";

export interface PluginViewActions {
  updateActorParams(partial: ParameterValues): void;
  openSiblingView(viewType: string): void;
  focusView(viewId: string): void;
  closeView(viewId: string): void;
}

/**
 * A snapshot of one editor-selected actor, handed to app-wide plugin
 * components (runtime / inspector) via {@link PluginHostBridge}. External
 * plugins cannot import host modules (`@/...`) and so cannot reach the kernel
 * store directly; this is their sanctioned, stable view of "what is selected".
 */
export interface PluginHostActorSnapshot {
  id: string;
  name: string;
  actorType: string;
  pluginType?: string;
  /** Current parameter values (`actor.params`). */
  params: ParameterValues;
  /**
   * The resolved descriptor schema for this actor, or `null` when no
   * descriptor is registered for its type (no schema available).
   */
  schema: ParameterSchema | null;
  /** The "common" inspector controls (above the descriptor params): the
   *  actor transform (rotation in radians), enabled flag, visibility mode. */
  transform: TransformTRS;
  enabled: boolean;
  visibilityMode: ActorVisibilityMode;
}

/**
 * Host bridge passed to app-wide plugin components. It is recomputed by the
 * host on selection / parameter / descriptor changes, so a component that
 * reads it re-renders when the selection or its values change. Mutations go
 * through the same kernel path the built-in inspector UI uses.
 */
export interface PluginHostBridge {
  /** Editor-selected actors, in selection order. Empty when none selected. */
  selectedActors: PluginHostActorSnapshot[];
  /**
   * Apply a partial parameter update to an actor. `history` defaults to
   * `true` (undoable, like a deliberate inspector edit); pass `false` for
   * high-frequency live edits (e.g. a hardware encoder being turned).
   */
  updateActorParams(
    actorId: string,
    partial: ParameterValues,
    options?: { history?: boolean }
  ): void;
  /** Set one transform channel (rotation in radians, like `actor.transform`). */
  updateActorTransform(
    actorId: string,
    key: "position" | "rotation" | "scale",
    value: [number, number, number],
    options?: { history?: boolean }
  ): void;
  /** Toggle the actor's enabled flag. */
  updateActorEnabled(actorId: string, enabled: boolean): void;
  /** Set the actor's visibility mode. */
  updateActorVisibility(actorId: string, mode: ActorVisibilityMode): void;
  /** Current transport playback state. Mirrors `state.time.running`. */
  transportPlaying: boolean;
  /** Toggle transport play/pause (same effect as the Space-bar shortcut). */
  toggleTransport(): void;
}

export interface PluginViewComponentProps {
  pluginView: PluginViewState;
  actor: ActorNode | null;
  runtimeStatus: ActorRuntimeStatus | null;
  actions: PluginViewActions;
}

export interface PluginInspectorComponentProps {
  plugin: RegisteredPlugin;
  /** Live view of editor selection + a param-write path. See {@link PluginHostBridge}. */
  host: PluginHostBridge;
}

export interface PluginRotoControlComponentProps {
  plugin: RegisteredPlugin;
}

export interface PluginRuntimeComponentProps {
  plugin: RegisteredPlugin;
  /** Live view of editor selection + a param-write path. See {@link PluginHostBridge}. */
  host: PluginHostBridge;
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
  inspectorComponent?: ComponentType<PluginInspectorComponentProps>;
  rotoControlComponent?: ComponentType<PluginRotoControlComponentProps>;
  runtimeComponent?: ComponentType<PluginRuntimeComponentProps>;
}

export interface PluginDefinitionInput {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
  viewDescriptors?: PluginViewDescriptor[];
  inspectorComponent?: ComponentType<PluginInspectorComponentProps>;
  rotoControlComponent?: ComponentType<PluginRotoControlComponentProps>;
  runtimeComponent?: ComponentType<PluginRuntimeComponentProps>;
}

export interface RegisteredPlugin {
  definition: PluginDefinition;
  manifest?: PluginManifest;
    source?: {
      modulePath: string;
      sourceGroup?: "plugins-external" | "plugins" | "manual";
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
  getPluginById(pluginId: string): RegisteredPlugin | null;
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
    getPluginById(pluginId) {
      return plugins.get(pluginId) ?? null;
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

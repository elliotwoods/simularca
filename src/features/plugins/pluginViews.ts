import type { ActorNode, PluginViewState } from "@/core/types";
import type { RegisteredPlugin } from "@/features/plugins/pluginApi";

export function createPluginViewInstanceId(pluginId: string, actorId: string, viewType: string): string {
  return `plugin-view:${pluginId}:${actorId}:${viewType}`;
}

export function createPluginViewTabId(pluginId: string, actorId: string, viewType: string): string {
  return `tab.plugin-view:${pluginId}:${actorId}:${viewType}`;
}

export function resolveActorPlugin(actor: ActorNode, plugins: RegisteredPlugin[]): RegisteredPlugin | null {
  if (actor.actorType !== "plugin" || !actor.pluginType) {
    return null;
  }
  for (const plugin of plugins) {
    if (
      plugin.definition.actorDescriptors.some(
        (descriptor) => descriptor.spawn?.actorType === "plugin" && descriptor.spawn.pluginType === actor.pluginType
      )
    ) {
      return plugin;
    }
  }
  return null;
}

export function sortOpenPluginViews(pluginViews: Record<string, PluginViewState>): PluginViewState[] {
  return Object.values(pluginViews)
    .filter((view) => view.open)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

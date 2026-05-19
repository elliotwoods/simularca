import { useMemo } from "react";
import type { AppKernel } from "@/app/kernel";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type {
  ActorNode,
  ActorVisibilityMode,
  ParameterValues,
  SelectionEntry
} from "@/core/types";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import type { PluginHostActorSnapshot, PluginHostBridge } from "./pluginApi";

function resolveActorSchema(
  actor: ActorNode,
  descriptors: ReloadableDescriptor[]
): PluginHostActorSnapshot["schema"] {
  const descriptor = descriptors.find(
    (entry) =>
      entry.spawn &&
      entry.spawn.actorType === actor.actorType &&
      entry.spawn.pluginType === actor.pluginType
  );
  return descriptor?.schema ?? null;
}

/**
 * Pure builder for the {@link PluginHostBridge}. Kept separate from the hook so
 * call sites that already hold the kernel + state slices (e.g. the giant
 * InspectorPane render) can build it inline without introducing a hook.
 */
export function buildPluginHostBridge(
  kernel: AppKernel,
  selection: SelectionEntry[],
  actors: Record<string, ActorNode>,
  actorDescriptors: ReloadableDescriptor[]
): PluginHostBridge {
  const selectedActors: PluginHostActorSnapshot[] = [];
  for (const entry of selection) {
    if (entry.kind !== "actor") {
      continue;
    }
    const actor = actors[entry.id];
    if (!actor) {
      continue;
    }
    selectedActors.push({
      id: actor.id,
      name: actor.name,
      actorType: actor.actorType,
      pluginType: actor.pluginType,
      params: actor.params,
      schema: resolveActorSchema(actor, actorDescriptors),
      transform: actor.transform,
      enabled: actor.enabled,
      visibilityMode: actor.visibilityMode
    });
  }
  return {
    selectedActors,
    updateActorParams(actorId: string, partial: ParameterValues, options) {
      const actions = kernel.store.getState().actions;
      if (options?.history === false) {
        actions.updateActorParamsNoHistory(actorId, partial);
        return;
      }
      actions.updateActorParams(actorId, partial);
    },
    updateActorTransform(actorId, key, value, options) {
      const actions = kernel.store.getState().actions;
      if (options?.history === false) {
        actions.setActorTransformNoHistory(actorId, key, value);
        return;
      }
      actions.setActorTransform(actorId, key, value);
    },
    updateActorEnabled(actorId, enabled) {
      kernel.store.getState().actions.setNodeEnabled({ kind: "actor", id: actorId }, enabled);
    },
    updateActorVisibility(actorId, mode: ActorVisibilityMode) {
      kernel.store.getState().actions.setActorVisibilityMode(actorId, mode);
    }
  };
}

/**
 * Reactive {@link PluginHostBridge} for app-wide plugin components mounted in
 * the React tree (the always-on runtime host). Recomputes when the editor
 * selection or any actor's params change.
 */
export function usePluginHostBridge(): PluginHostBridge {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  return useMemo(
    () => buildPluginHostBridge(kernel, selection, actors, kernel.descriptorRegistry.listByKind("actor")),
    [kernel, selection, actors]
  );
}

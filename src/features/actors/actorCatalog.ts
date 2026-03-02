import type { AppKernel } from "@/app/kernel";
import type { ActorType } from "@/core/types";

export interface ActorCreationOption {
  descriptorId: string;
  label: string;
  description: string;
  iconGlyph: string;
  actorType: ActorType;
  pluginType?: string;
  pluginBacked: boolean;
}

export function listActorCreationOptions(kernel: AppKernel): ActorCreationOption[] {
  const pluginDescriptorIds = new Set(
    kernel.pluginApi
      .listPlugins()
      .flatMap((entry) => entry.definition.actorDescriptors.map((descriptor) => descriptor.id))
  );

  return kernel.descriptorRegistry
    .listByKind("actor")
    .map((descriptor) => {
      const actorType: ActorType = descriptor.spawn?.actorType ?? "plugin";
      const pluginType = descriptor.spawn?.pluginType ?? (descriptor.spawn ? undefined : descriptor.id);
      return {
        descriptorId: descriptor.id,
        label: descriptor.spawn?.label ?? descriptor.schema.title,
        description:
          descriptor.spawn?.description ??
          (pluginDescriptorIds.has(descriptor.id)
            ? "Actor supplied by a loaded plugin."
            : "Core actor type."),
        iconGlyph: descriptor.spawn?.iconGlyph ?? (descriptor.spawn?.label ?? descriptor.schema.title).slice(0, 2).toUpperCase(),
        actorType,
        pluginType,
        pluginBacked: pluginDescriptorIds.has(descriptor.id)
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function createActorFromDescriptor(kernel: AppKernel, descriptorId: string): string | null {
  const option = listActorCreationOptions(kernel).find((entry) => entry.descriptorId === descriptorId);
  if (!option) {
    return null;
  }
  const actorId = kernel.store.getState().actions.createActor({
    actorType: option.actorType,
    pluginType: option.pluginType,
    name: option.label
  });
  // Seed known core actor defaults so inspector bindings start with stable values.
  if (descriptorId === "actor.gaussianSplat") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      scaleFactor: 1,
      opacity: 1,
      pointSize: 0.02
    });
  }
  if (descriptorId === "actor.mesh") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      scaleFactor: 1
    });
  }
  if (descriptorId === "actor.environment") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      intensity: 1
    });
  }
  if (descriptorId === "actor.primitive") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      shape: "cube",
      size: 1,
      segments: 24,
      color: "#4fb3ff",
      wireframe: false
    });
  }
  return actorId;
}

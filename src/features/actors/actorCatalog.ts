import type { AppKernel } from "@/app/kernel";
import type { ActorType } from "@/core/types";
import { buildDefaultCameraPathKeyframes, buildSinglePointCurveData } from "@/features/cameraPath/model";
import { createDefaultCurveData } from "@/features/curves/types";

export interface ActorCreationOption {
  descriptorId: string;
  label: string;
  description: string;
  iconGlyph: string;
  actorType: ActorType;
  pluginType?: string;
  pluginBacked: boolean;
  groupKey: string;
  groupLabel: string;
  pluginName?: string;
}

export function listActorCreationOptions(kernel: AppKernel): ActorCreationOption[] {
  const pluginByDescriptorId = new Map<string, { pluginId: string; pluginName: string }>();
  for (const entry of kernel.pluginApi.listPlugins()) {
    const pluginName = entry.manifest?.name ?? entry.definition.name;
    for (const descriptor of entry.definition.actorDescriptors) {
      pluginByDescriptorId.set(descriptor.id, {
        pluginId: entry.definition.id,
        pluginName
      });
    }
  }

  return kernel.descriptorRegistry
    .listByKind("actor")
    .filter((descriptor) => Boolean(descriptor.spawn))
    .map((descriptor) => {
      const actorType: ActorType = descriptor.spawn!.actorType;
      const pluginType = descriptor.spawn!.pluginType;
      const pluginEntry = pluginByDescriptorId.get(descriptor.id);
      const pluginBacked = Boolean(pluginEntry);
      const groupKey = pluginEntry ? `plugin:${pluginEntry.pluginId}` : "core";
      const groupLabel = pluginEntry ? pluginEntry.pluginName : "Core";
      return {
        descriptorId: descriptor.id,
        label: descriptor.spawn!.label ?? descriptor.schema.title,
        description:
          descriptor.spawn!.description ??
          (pluginBacked
            ? "Actor supplied by a loaded plugin."
            : "Core actor type."),
        iconGlyph: descriptor.spawn!.iconGlyph ?? (descriptor.spawn!.label ?? descriptor.schema.title).slice(0, 2).toUpperCase(),
        actorType,
        pluginType,
        pluginBacked,
        groupKey,
        groupLabel,
        pluginName: pluginEntry?.pluginName
      };
    })
    .sort((a, b) => {
      if (a.groupLabel !== b.groupLabel) {
        return a.groupLabel.localeCompare(b.groupLabel);
      }
      return a.label.localeCompare(b.label);
    });
}

export function createActorFromDescriptor(kernel: AppKernel, descriptorId: string): string | null {
  const option = listActorCreationOptions(kernel).find((entry) => entry.descriptorId === descriptorId);
  if (!option) {
    return null;
  }
  if (descriptorId === "actor.cameraPath") {
    const actions = kernel.store.getState().actions;
    const camera = kernel.store.getState().state.camera;
    actions.pushHistory("Create actor");
    const actorId = actions.createActorNoHistory({
      actorType: option.actorType,
      pluginType: option.pluginType,
      name: option.label,
      select: false
    });
    const positionCurveActorId = actions.createActorNoHistory({
      actorType: "curve",
      name: "camera position",
      parentActorId: actorId,
      select: false
    });
    const targetCurveActorId = actions.createActorNoHistory({
      actorType: "curve",
      name: "camera target",
      parentActorId: actorId,
      select: false
    });
    actions.updateActorParamsNoHistory(positionCurveActorId, {
      closed: false,
      samplesPerSegment: 24,
      handleSize: 0.5,
      curveData: buildSinglePointCurveData(camera.position)
    });
    actions.updateActorParamsNoHistory(targetCurveActorId, {
      closed: false,
      samplesPerSegment: 24,
      handleSize: 0.5,
      curveData: buildSinglePointCurveData(camera.target)
    });
    actions.updateActorParamsNoHistory(actorId, {
      positionCurveActorId,
      targetCurveActorId,
      targetMode: "curve",
      targetActorId: "",
      keyframes: buildDefaultCameraPathKeyframes(1)
    });
    actions.select([{ kind: "actor", id: actorId }]);
    return actorId;
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
      splatSize: 1,
      opacity: 1,
      filterMode: "off",
      filterRegionActorIds: []
    });
  }
  if (descriptorId === "actor.gaussianSplatSpark") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      scaleFactor: 1,
      opacity: 1
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
      shape: "sphere",
      cubeSize: 1,
      sphereRadius: 0.5,
      cylinderRadius: 0.5,
      cylinderHeight: 1,
      segments: 24,
      color: "#4fb3ff",
      wireframe: false
    });
  }
  if (descriptorId === "actor.curve") {
    const curveData = createDefaultCurveData();
    kernel.store.getState().actions.updateActorParams(actorId, {
      closed: false,
      samplesPerSegment: 24,
      handleSize: 0.5,
      curveData
    });
  }
  return actorId;
}

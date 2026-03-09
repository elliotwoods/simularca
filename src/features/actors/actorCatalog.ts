import type { AppKernel } from "@/app/kernel";
import type { ActorType } from "@/core/types";
import { buildDefaultCameraPathKeyframes, buildSinglePointCurveData } from "@/features/cameraPath/model";
import { createDefaultCurveData } from "@/features/curves/types";
import { buildMistLookupNoiseParams } from "@/features/actors/mistVolumeLookupNoise";

const CIRCLE_ACTOR_DESCRIPTOR_ID = "actor.curve.circle";

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

  const options = kernel.descriptorRegistry
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
    });

  const curveOption = options.find((entry) => entry.descriptorId === "actor.curve");
  if (curveOption) {
    options.push({
      ...curveOption,
      descriptorId: CIRCLE_ACTOR_DESCRIPTOR_ID,
      label: "Circle",
      description: "Analytic circle curve with no control points.",
      iconGlyph: "CI"
    });
  }

  return options
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
      curveType: "spline",
      closed: false,
      samplesPerSegment: 24,
      handleSize: 0.5,
      curveData: buildSinglePointCurveData(camera.position)
    });
    actions.updateActorParamsNoHistory(targetCurveActorId, {
      curveType: "spline",
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
  if (descriptorId === "actor.gaussianSplatSpark") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      scaleFactor: 1,
      opacity: 1,
      brightness: 1,
      colorInputSpace: "srgb",
      stochasticDepth: false
    });
  }
  if (descriptorId === "actor.mesh") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      scaleFactor: 1
    });
  }
  if (descriptorId === "actor.mistVolume") {
    kernel.store.getState().actions.updateActorParams(actorId, {
      volumeActorId: "",
      sourceActorIds: [],
      resolutionX: 32,
      resolutionY: 24,
      resolutionZ: 32,
      sourceRadius: 0.2,
      injectionRate: 1,
      initialSpeed: 0.6,
      emissionDirection: [0, -1, 0],
      buoyancy: 0.35,
      velocityDrag: 0.12,
      diffusion: 0.04,
      densityDecay: 0.08,
      simulationSubsteps: 1,
      noiseSeed: 1,
      emissionNoiseStrength: 0,
      emissionNoiseScale: 1,
      emissionNoiseSpeed: 0.75,
      windVector: [0, 0, 0],
      windNoiseStrength: 0,
      windNoiseScale: 0.75,
      windNoiseSpeed: 0.25,
      wispiness: 0,
      edgeBreakup: 0,
      ...buildMistLookupNoiseParams("cloudy"),
      surfaceNegXMode: "open",
      surfacePosXMode: "open",
      surfaceNegYMode: "open",
      surfacePosYMode: "open",
      surfaceNegZMode: "open",
      surfacePosZMode: "open",
      previewMode: "volume",
      previewTint: "#d9eef7",
      previewOpacity: 1.1,
      previewThreshold: 0.02,
      slicePosition: 0.5,
      previewRaymarchSteps: 48,
      renderOverrideEnabled: false,
      renderResolutionX: 64,
      renderResolutionY: 48,
      renderResolutionZ: 64,
      renderSimulationSubsteps: 2,
      renderPreviewRaymarchSteps: 96
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
      curveType: "spline",
      closed: false,
      samplesPerSegment: 24,
      handleSize: 0.5,
      curveData
    });
  }
  if (descriptorId === CIRCLE_ACTOR_DESCRIPTOR_ID) {
    kernel.store.getState().actions.updateActorParams(actorId, {
      curveType: "circle",
      radius: 1,
      samplesPerSegment: 64,
      handleSize: 0.5
    });
  }
  return actorId;
}

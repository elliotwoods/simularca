import type * as THREE from "three";

export type PrimitiveShape = "sphere" | "cube" | "cylinder";
export type BeamType = "solid" | "ghost" | "normals" | "scatteringShell";
export type ActorType =
  | "plugin"
  | "empty"
  | "environment"
  | "gaussian-splat"
  | "gaussian-splat-spark"
  | "mesh"
  | "primitive"
  | "curve";

export type ParameterValue = number | string | boolean | string[] | object | null | undefined;
export type ParameterValues = Record<string, ParameterValue>;

export interface TransformTRS {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface ActorNode {
  id: string;
  name: string;
  enabled: boolean;
  actorType: ActorType;
  pluginType?: string;
  parentActorId: string | null;
  childActorIds: string[];
  componentIds: string[];
  transform: TransformTRS;
  params: ParameterValues;
}

export interface AppState {
  actors: Record<string, ActorNode>;
  camera?: {
    position: [number, number, number];
  };
}

export interface ActorRuntimeStatus {
  values: Record<string, unknown>;
  error?: string;
  updatedAtIso: string;
}

export interface ActorStatusEntry {
  label: string;
  value: string | number | boolean | [number, number, number] | string[] | object | null | undefined;
  tone?: "default" | "warning" | "error";
}

export interface ParameterSchema {
  id: string;
  title: string;
  params: Array<Record<string, unknown>>;
}

export interface ReloadableDescriptor<TRuntime = unknown> {
  id: string;
  kind: "actor" | "component" | "system";
  version: number;
  schema: ParameterSchema;
  spawn?: {
    actorType: ActorType;
    pluginType?: string;
    label?: string;
    description?: string;
    iconGlyph?: string;
    fileExtensions?: string[];
  };
  createRuntime(args: { params: ParameterValues }): TRuntime;
  updateRuntime(runtime: TRuntime, args: { params: ParameterValues; dtSeconds: number }): void;
  sceneHooks?: {
    createObject?(args: { actor: ActorNode; state: AppState }): unknown;
    syncObject?(context: SceneHookContext): void;
    disposeObject?(args: { actor: ActorNode; state: AppState; object: unknown }): void;
  };
  status?: {
    build(context: {
      actor: ActorNode;
      state: AppState;
      runtimeStatus?: ActorRuntimeStatus;
    }): ActorStatusEntry[];
  };
}

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
}

export interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  };
}

export interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinition;
}

export interface SceneHookContext {
  actor: ActorNode;
  state: AppState;
  object: unknown;
  simTimeSeconds: number;
  dtSeconds: number;
  getActorById(actorId: string): ActorNode | null;
  getActorObject(actorId: string): unknown | null;
  sampleCurveWorldPoint(
    actorId: string,
    t: number
  ): {
    position: [number, number, number];
    tangent: [number, number, number];
  } | null;
  setActorStatus(status: ActorRuntimeStatus | null): void;
}

export interface BeamParams {
  targetActorId: string | null;
  beamType: BeamType;
  resolution: number;
  beamLength: number;
  beamColor: string;
  beamAlpha: number;
  hazeIntensity: number;
  scatteringCoeff: number;
  extinctionCoeff: number;
  anisotropyG: number;
  beamDivergenceRad: number;
  beamApertureDiameter: number;
  distanceFalloffExponent: number;
  pathLengthGain: number;
  pathLengthExponent: number;
  phaseGain: number;
  scanDuty: number;
  nearFadeStart: number;
  nearFadeEnd: number;
  softClampKnee: number;
}

export interface BeamArrayParams extends BeamParams {
  emitterCurveId: string | null;
  count: number;
}

export interface PrimitiveDimensions {
  cubeSize: number;
  sphereRadius: number;
  cylinderRadius: number;
  cylinderHeight: number;
}

export interface BeamBuildInput {
  shape: PrimitiveShape;
  dimensions: PrimitiveDimensions;
  targetWorldMatrix: THREE.Matrix4;
  emitterWorld: THREE.Vector3;
  resolution: number;
}

export interface SilhouetteResult {
  ok: boolean;
  reason?: string;
  contourWorld: THREE.Vector3[];
  targetCenterWorld: THREE.Vector3;
}

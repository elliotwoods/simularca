// Local copies of the host's plugin handshake + descriptor contract.
// The host (Simularca) supplies the real runtime objects; these interfaces describe
// only the subset this plugin reads/writes. Kept structurally compatible with
// src/core/hotReload/types.ts and src/features/plugins/contracts.ts in the host repo.

export type PluginParameterValue =
  | number
  | string
  | boolean
  | number[]
  | string[]
  | null;

export interface VisibilityRule {
  key: string;
  equals: string | number | boolean | Array<string | number | boolean>;
}

interface ParameterBase {
  key: string;
  label: string;
  description?: string;
  defaultValue?: PluginParameterValue;
  groupKey?: string;
  groupLabel?: string;
  visibleWhen?: VisibilityRule[];
}

export interface NumberParameter extends ParameterBase {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
}

export interface BooleanParameter extends ParameterBase {
  type: "boolean";
}

export interface ColorParameter extends ParameterBase {
  type: "color";
  alpha?: boolean;
}

export interface SelectParameter extends ParameterBase {
  type: "select";
  options: string[];
}

export interface ActorRefParameter extends ParameterBase {
  type: "actor-ref";
  allowedActorTypes?: string[];
  allowSelf?: boolean;
}

export type PluginParameter =
  | NumberParameter
  | BooleanParameter
  | ColorParameter
  | SelectParameter
  | ActorRefParameter;

export interface ParameterSchema {
  id: string;
  title: string;
  params: PluginParameter[];
}

export type ParameterValues = Record<string, PluginParameterValue | undefined>;

export interface PluginActorNode {
  id: string;
  name: string;
  params: ParameterValues;
}

export type ActorStatusValue = string | number | boolean | null;

export interface ActorRuntimeStatus {
  values: Record<string, ActorStatusValue | undefined>;
  error?: string;
  updatedAtIso: string;
}

// A world-space beam cone published for illuminating actors that don't respond to THREE
// lights (gaussian splats). Mirrors the host's BeamLight resource type.
export interface BeamLight {
  position: [number, number, number];
  direction: [number, number, number];
  cosHalfAngle: number;
  color: [number, number, number];
  intensity: number;
  range: number;
  penumbra: number;
}

// The host passes a richer context (see SceneHookContext in the host repo). These are
// the members this plugin uses; `object` and `getActorObject(...)` return THREE
// Object3D instances from the host's (shared) THREE module.
export interface SceneHookContext {
  actor: PluginActorNode;
  object: unknown;
  runtime: unknown;
  simTimeSeconds: number;
  dtSeconds: number;
  getActorById(actorId: string): PluginActorNode | null;
  getActorObject(actorId: string): unknown | null;
  setActorStatus(status: ActorRuntimeStatus | null): void;
  updateActorParams(
    actorId: string,
    partial: ParameterValues,
    options?: { history?: boolean }
  ): void;
  /** Publish this actor's beam cones to the host registry (read by the splat material).
   *  Optional: older hosts may not provide it. */
  setBeamLights?(actorId: string, lights: BeamLight[]): void;
}

export interface DescriptorSceneHooks {
  createObject(args: { actor: PluginActorNode }): unknown;
  syncObject(context: SceneHookContext): void;
  disposeObject(args: { actor: PluginActorNode; object: unknown }): void;
}

export interface ReloadableDescriptor<TRuntime = unknown> {
  id: string;
  kind: "actor";
  version: number;
  schema: ParameterSchema;
  spawn?: {
    actorType: "plugin";
    pluginType?: string;
    label?: string;
    description?: string;
    iconGlyph?: string;
    fileExtensions?: string[];
  };
  createRuntime(args: { params: ParameterValues }): TRuntime;
  updateRuntime(runtime: TRuntime, args: { params: ParameterValues; dtSeconds: number }): void;
  disposeRuntime?(runtime: TRuntime): void;
  sceneHooks?: DescriptorSceneHooks;
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

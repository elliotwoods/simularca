import type {
  ActorNode,
  ActorRuntimeStatus,
  ActorStatusValue,
  AppState,
  ActorType,
  MistVolumeResource,
  VolumetricRayFieldResource,
  ParameterSchema,
  ParameterValues
} from "@/core/types";

export type DescriptorKind = "actor" | "component" | "system";
export interface ParamMigration {
  fromVersion: number;
  toVersion: number;
  migrate(params: ParameterValues): ParameterValues;
}

export interface ActorStatusEntry {
  label: string;
  value: ActorStatusValue | null | undefined;
  tone?: "default" | "warning" | "error";
  groupKey?: string;
  groupLabel?: string;
}

export interface ActorStatusContext {
  actor: ActorNode;
  state: AppState;
  runtimeStatus?: ActorRuntimeStatus;
}

export interface SceneHookContext {
  actor: ActorNode;
  state: AppState;
  object: unknown;
  runtime: unknown | null;
  simTimeSeconds: number;
  dtSeconds: number;
  getActorById(actorId: string): ActorNode | null;
  getActorObject(actorId: string): unknown | null;
  getActorRuntime(actorId: string): unknown | null;
  sampleCurveWorldPoint(
    actorId: string,
    t: number
  ): {
    position: [number, number, number];
    tangent: [number, number, number];
  } | null;
  getMistVolumeResource(actorId: string): MistVolumeResource | null;
  getVolumetricRayResource(actorId: string): VolumetricRayFieldResource | null;
  setActorStatus(status: ActorRuntimeStatus | null): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
}

export interface DescriptorSceneHooks {
  createObject?(args: { actor: ActorNode; state: AppState }): unknown;
  syncObject?(context: SceneHookContext): void;
  disposeObject?(args: { actor: ActorNode; state: AppState; object: unknown }): void;
}

export interface ReloadableDescriptor<TRuntime = unknown> {
  id: string;
  kind: DescriptorKind;
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
  disposeRuntime?(runtime: TRuntime): void;
  sceneHooks?: DescriptorSceneHooks;
  status?: {
    build(context: ActorStatusContext): ActorStatusEntry[];
  };
  migrations?: ParamMigration[];
}

export interface RuntimeInstanceHandle<TRuntime = unknown> {
  instanceId: string;
  descriptorId: string;
  runtime: TRuntime;
  status: "running" | "rebuilding" | "disposed";
}

export interface HotReloadEvent {
  moduleId: string;
  changeType: "added" | "replaced" | "removed";
  applied: boolean;
  fallbackReason?: string;
}

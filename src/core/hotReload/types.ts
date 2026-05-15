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
  /**
   * Returns a signature that changes whenever a curve actor's effective polyline
   * data changes — including the projected polyline of a mesh-projection curve,
   * which lives in an in-memory cache rather than on the actor's params. Plugins
   * that cache results derived from a curve should include this in their own
   * signature/skip-recompute hash. Returns null if the actor isn't a curve, or
   * has no derived polyline (e.g. plain spline/circle — for those the curve's
   * data already lives in actor.params and downstream params hashing is enough).
   */
  getCurveSignature(actorId: string): string | null;
  getMistVolumeResource(actorId: string): MistVolumeResource | null;
  getVolumetricRayResource(actorId: string): VolumetricRayFieldResource | null;
  profileChunk?<T>(label: string, run: () => T): T;
  setActorStatus(status: ActorRuntimeStatus | null): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
  /**
   * Publish an environment IBL texture for this actor. Pass null to clear.
   * The host will own the texture lifecycle in conjunction with disposeObject.
   */
  setEnvironmentTexture(texture: unknown | null): void;
  /**
   * Access the underlying THREE renderer + PMREM generator. Plugin actors that
   * need to render to texture or build IBL should request these on demand.
   */
  getRenderer(): unknown | null;
  getPmremGenerator(): unknown | null;
  /**
   * Build a procedural Preetham sky IBL texture in the host's THREE module instance.
   * Plugins can't do this themselves because their dynamically-loaded ESM pulls in a
   * separate THREE instance which breaks NodeMaterial type checks. The host caches the
   * sky scene per actor and disposes it when the actor is removed.
   */
  generateSkyIbl(params: {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    sunDirection: [number, number, number];
    sigma?: number;
  }): unknown | null;
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
  /**
   * Optional dynamic-defaults hook called at actor-creation time. Returned values are
   * merged on top of the schema's static defaultValues. Use for time-sensitive or
   * non-serialisable defaults (e.g. `dateTime: new Date().toISOString()`).
   */
  createInitialParams?(): ParameterValues;
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

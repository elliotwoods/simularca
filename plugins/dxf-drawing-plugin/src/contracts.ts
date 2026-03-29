import type * as THREE from "three";

export type ActorType =
  | "plugin"
  | "empty"
  | "environment"
  | "gaussian-splat-spark"
  | "mist-volume"
  | "mesh"
  | "primitive"
  | "curve"
  | "camera-path";

export type ParameterValue = number | string | boolean | number[] | string[] | object | null | undefined;
export type ParameterValues = Record<string, ParameterValue>;
export type DxfInputUnits = "millimeters" | "centimeters" | "meters" | "inches" | "feet";
export type DxfDrawingPlane = "plan-xz" | "front-xy" | "side-zy";

export interface DxfLayerState {
  name: string;
  sourceColor: string;
  color: string;
  visible: boolean;
}

export type DxfLayerStateMap = Record<string, DxfLayerState>;

export interface TransformTRS {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface AssetRef {
  id: string;
  sourceFileName: string;
  relativePath: string;
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
  assets?: AssetRef[];
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
  readAssetBytes(assetId: string): Promise<Uint8Array>;
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

export interface TextMeshFactoryArgs {
  text: string;
  position: [number, number, number];
  rotationRadians: number;
  heightMeters: number;
  plane: DxfDrawingPlane;
  color: string;
}

export type Vector3Tuple = [number, number, number];

export interface RenderObjectApi {
  createTextMesh(args: TextMeshFactoryArgs): THREE.Mesh | null;
}

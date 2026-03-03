import type { AppMode, HdriTranscodeOptions, SessionAssetRef } from "@/types/ipc";

export const SESSION_SCHEMA_VERSION = 2;

export type SceneNodeKind = "scene" | "actor" | "component";
export type RenderEngine = "webgl2" | "webgpu";
export type ActorType =
  | "empty"
  | "environment"
  | "gaussian-splat"
  | "gaussian-splat-spark"
  | "mesh"
  | "primitive"
  | "curve"
  | "plugin";
export type ActorVisibilityMode = "visible" | "hidden" | "selected";
export type CameraPreset = "perspective" | "top" | "left" | "front" | "back" | "isometric";
export type TimeSpeedPreset = 0.125 | 0.25 | 0.5 | 1 | 2 | 4;
export type SelectionKind = "actor" | "component";
export type LogLevel = "info" | "warn" | "error";

export interface TransformTRS {
  // Scene unit policy: linear transform values are meters.
  position: [number, number, number];
  // Rotation values are stored in radians.
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface SceneNodeBase {
  id: string;
  name: string;
  enabled: boolean;
  kind: SceneNodeKind;
}

export interface ParameterDefinitionBase {
  key: string;
  label: string;
  description?: string;
  defaultValue?: number | string | boolean | string[];
  visibleWhen?: Array<{
    key: string;
    equals: string | number | boolean;
  }>;
}

export interface NumberParameterDefinition extends ParameterDefinitionBase {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  dragSpeed?: number;
}

export interface BooleanParameterDefinition extends ParameterDefinitionBase {
  type: "boolean";
}

export interface StringParameterDefinition extends ParameterDefinitionBase {
  type: "string";
}

export interface SelectParameterDefinition extends ParameterDefinitionBase {
  type: "select";
  options: string[];
}

export interface ActorRefParameterDefinition extends ParameterDefinitionBase {
  type: "actor-ref";
  allowedActorTypes?: ActorType[];
  allowSelf?: boolean;
}

export interface ActorRefListParameterDefinition extends ParameterDefinitionBase {
  type: "actor-ref-list";
  allowedActorTypes?: ActorType[];
  allowSelf?: boolean;
}

export interface FileParameterImportAsset {
  mode: "import-asset";
  kind: SessionAssetRef["kind"];
}

export interface FileParameterTranscodeHdri {
  mode: "transcode-hdri";
  options?: HdriTranscodeOptions;
}

export interface FileParameterDefinition extends ParameterDefinitionBase {
  type: "file";
  accept: string[];
  dialogTitle?: string;
  import: FileParameterImportAsset | FileParameterTranscodeHdri;
}

export type ParameterDefinition =
  | NumberParameterDefinition
  | BooleanParameterDefinition
  | StringParameterDefinition
  | SelectParameterDefinition
  | ActorRefParameterDefinition
  | ActorRefListParameterDefinition
  | FileParameterDefinition;

export interface ParameterSchema {
  id: string;
  title: string;
  params: ParameterDefinition[];
}

export type ParameterValue = number | string | boolean | string[] | object | null;

export type ParameterValues = Record<string, ParameterValue>;

export interface ComponentNode extends SceneNodeBase {
  kind: "component";
  parentActorId: string | null;
  componentType: string;
  schemaId: string;
  params: ParameterValues;
}

export interface ActorNode extends SceneNodeBase {
  kind: "actor";
  actorType: ActorType;
  visibilityMode: ActorVisibilityMode;
  pluginType?: string;
  parentActorId: string | null;
  childActorIds: string[];
  componentIds: string[];
  transform: TransformTRS;
  params: ParameterValues;
}

export interface SceneState extends SceneNodeBase {
  kind: "scene";
  actorIds: string[];
  sceneComponentIds: string[];
  backgroundColor: string;
  renderEngine: RenderEngine;
  antialiasing: boolean;
}

export interface CameraState {
  mode: "perspective" | "orthographic";
  // Position and target are in meters.
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  zoom: number;
  near: number;
  far: number;
}

export interface CameraBookmark {
  id: string;
  name: string;
  camera: CameraState;
}

export interface TimeState {
  running: boolean;
  speed: TimeSpeedPreset;
  fixedStepSeconds: number;
  elapsedSimSeconds: number;
}

export interface SelectionEntry {
  kind: SelectionKind;
  id: string;
}

export interface SessionManifest {
  schemaVersion: number;
  appMode: AppMode;
  sessionName: string;
  createdAtIso: string;
  updatedAtIso: string;
  scene: SceneState;
  actors: Record<string, ActorNode>;
  components: Record<string, ComponentNode>;
  camera: CameraState;
  cameraBookmarks: CameraBookmark[];
  time: TimeState;
  assets: SessionAssetRef[];
}

export interface SceneStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  splatDrawCalls: number;
  splatTriangles: number;
  splatVisibleCount: number;
  memoryMb: number;
  heapMb: number;
  resourceMb: number;
  actorCount: number;
  actorCountEnabled: number;
  sessionFileBytes: number;
  sessionFileBytesSaved: number;
  cameraDistance: number;
  cameraControlsEnabled: boolean;
  cameraZoomEnabled: boolean;
}

export type ActorStatusValue = string | number | boolean | [number, number, number];

export interface ActorRuntimeStatus {
  values: Record<string, ActorStatusValue | undefined>;
  error?: string;
  updatedAtIso: string;
}

export interface ConsoleLogEntry {
  kind: "log";
  id: string;
  level: LogLevel;
  message: string;
  timestampIso: string;
  details?: string;
}

export type ConsoleCommandStatus = "running" | "success" | "error";

export interface ConsoleCommandEntry {
  kind: "command";
  id: string;
  source: string;
  status: ConsoleCommandStatus;
  timestampIso: string;
  finishedAtIso?: string;
  summary?: string;
  result?: unknown;
  error?: string;
  details?: string;
}

export type ConsoleEntry = ConsoleLogEntry | ConsoleCommandEntry;

export interface AppState {
  mode: AppMode;
  activeSessionName: string;
  scene: SceneState;
  actors: Record<string, ActorNode>;
  components: Record<string, ComponentNode>;
  camera: CameraState;
  cameraBookmarks: CameraBookmark[];
  time: TimeState;
  assets: SessionAssetRef[];
  selection: SelectionEntry[];
  stats: SceneStats;
  dirty: boolean;
  statusMessage: string;
  consoleEntries: ConsoleEntry[];
  actorStatusByActorId: Record<string, ActorRuntimeStatus>;
}


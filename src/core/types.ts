import type { AppMode, HdriTranscodeOptions, SessionAssetRef } from "@/types/ipc";

export const SESSION_SCHEMA_VERSION = 1;

export type SceneNodeKind = "scene" | "actor" | "component";
export type ActorType = "empty" | "environment" | "gaussian-splat" | "primitive" | "plugin";
export type CameraPreset = "perspective" | "top" | "left" | "front" | "back" | "isometric";
export type TimeSpeedPreset = 0.125 | 0.25 | 0.5 | 1 | 2 | 4;
export type SelectionKind = "actor" | "component";
export type LogLevel = "info" | "warn" | "error";

export interface TransformTRS {
  position: [number, number, number];
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
  | FileParameterDefinition;

export interface ParameterSchema {
  id: string;
  title: string;
  params: ParameterDefinition[];
}

export type ParameterValues = Record<string, number | string | boolean>;

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
}

export interface CameraState {
  mode: "perspective" | "orthographic";
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
  drawCalls: number;
  triangles: number;
  memoryMb: number;
  actorCount: number;
  sessionFileBytes: number;
}

export interface SplatDiagnostics {
  backend: "fallback-ply" | "dedicated-overlay" | "unknown";
  loader: string;
  loaderVersion?: string;
  assetFileName?: string;
  pointCount?: number;
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  error?: string;
  updatedAtIso: string;
}

export interface ConsoleLogEntry {
  id: string;
  level: LogLevel;
  message: string;
  timestampIso: string;
  details?: string;
}

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
  consoleLogs: ConsoleLogEntry[];
  splatDiagnosticsByActorId: Record<string, SplatDiagnostics>;
}


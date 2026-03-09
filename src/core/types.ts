import type { AppMode, HdriTranscodeOptions, ProjectAssetRef } from "@/types/ipc";

export const PROJECT_SCHEMA_VERSION = 4;

export type SceneNodeKind = "scene" | "actor" | "component";
export type RenderEngine = "webgl2" | "webgpu";
export type SceneToneMappingMode = "off" | "aces";
export type SceneFramePacingMode = "vsync" | "fixed";
export type SplatColorInputSpace = "linear" | "srgb" | "iphone-sdr";
export type ActorType =
  | "empty"
  | "environment"
  | "gaussian-splat-spark"
  | "mist-volume"
  | "mesh"
  | "primitive"
  | "curve"
  | "camera-path"
  | "plugin";

export type MaterialColorChannel =
  | { mode: "color"; color: string }
  | { mode: "image"; assetId: string };

export type MaterialScalarChannel =
  | { mode: "scalar"; value: number }
  | { mode: "image"; assetId: string };

export interface Material {
  id: string;
  name: string;
  albedo: MaterialColorChannel;
  metalness: MaterialScalarChannel;
  roughness: MaterialScalarChannel;
  normalMap: { assetId: string } | null;
  emissive: MaterialColorChannel;
  emissiveIntensity: number;
  opacity: number; // 0-1
  transparent: boolean;
  side: "front" | "back" | "double";
  wireframe: boolean;
}

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

export interface SceneTonemappingSettings {
  mode: SceneToneMappingMode;
  dither: boolean;
}

export interface SceneFramePacingSettings {
  mode: SceneFramePacingMode;
  targetFps: number;
}

export interface SceneBloomSettings {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}

export interface SceneVignetteSettings {
  enabled: boolean;
  offset: number;
  darkness: number;
}

export interface SceneChromaticAberrationSettings {
  enabled: boolean;
  offset: number;
}

export interface SceneGrainSettings {
  enabled: boolean;
  intensity: number;
}

export interface ScenePostProcessingSettings {
  bloom: SceneBloomSettings;
  vignette: SceneVignetteSettings;
  chromaticAberration: SceneChromaticAberrationSettings;
  grain: SceneGrainSettings;
}

export interface ParameterDefinitionBase {
  key: string;
  label: string;
  description?: string;
  defaultValue?: number | string | boolean | number[] | string[];
  groupKey?: string;
  groupLabel?: string;
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

export interface ColorParameterDefinition extends ParameterDefinitionBase {
  type: "color";
}

export interface Vector3ParameterDefinition extends ParameterDefinitionBase {
  type: "vector3";
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  dragSpeed?: number;
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

export interface MaterialRefParameterDefinition extends ParameterDefinitionBase {
  type: "material-ref";
}

export interface MaterialSlotsParameterDefinition extends ParameterDefinitionBase {
  type: "material-slots";
}

export interface FileParameterImportAsset {
  mode: "import-asset";
  kind: ProjectAssetRef["kind"];
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
  /** Param keys to null-out when this file is cleared or replaced with a different file. */
  clearsParams?: string[];
}

export type ParameterDefinition =
  | NumberParameterDefinition
  | BooleanParameterDefinition
  | StringParameterDefinition
  | ColorParameterDefinition
  | Vector3ParameterDefinition
  | SelectParameterDefinition
  | ActorRefParameterDefinition
  | ActorRefListParameterDefinition
  | MaterialRefParameterDefinition
  | MaterialSlotsParameterDefinition
  | FileParameterDefinition;

export interface ParameterSchema {
  id: string;
  title: string;
  params: ParameterDefinition[];
}

export type ParameterValue = number | string | boolean | number[] | string[] | object | null;

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
  framePacing: SceneFramePacingSettings;
  tonemapping: SceneTonemappingSettings;
  postProcessing: ScenePostProcessingSettings;
  cameraKeyboardNavigation: boolean;
  cameraNavigationSpeed: number;
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

export interface ProjectSnapshotManifest {
  schemaVersion: number;
  appMode: AppMode;
  projectName: string;
  snapshotName: string;
  createdAtIso: string;
  updatedAtIso: string;
  scene: SceneState;
  actors: Record<string, ActorNode>;
  components: Record<string, ComponentNode>;
  camera: CameraState;
  cameraBookmarks: CameraBookmark[];
  time: TimeState;
  materials: Record<string, Material>;
  assets: ProjectAssetRef[];
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
  projectFileBytes: number;
  projectFileBytesSaved: number;
  cameraDistance: number;
  cameraControlsEnabled: boolean;
  cameraZoomEnabled: boolean;
}

export interface RuntimeDebugState {
  slowFrameDiagnosticsEnabled: boolean;
  slowFrameDiagnosticsThresholdMs: number;
}

export type ActorStatusValue = string | number | boolean | number[] | string[] | object | null;

export interface ActorRuntimeStatus {
  values: Record<string, ActorStatusValue | undefined>;
  error?: string;
  updatedAtIso: string;
}

export interface MistVolumeResource {
  densityTexture: unknown;
  worldToLocalElements: number[];
  resolution: [number, number, number];
  densityScale: number;
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
  activeProjectName: string;
  activeSnapshotName: string;
  scene: SceneState;
  actors: Record<string, ActorNode>;
  components: Record<string, ComponentNode>;
  camera: CameraState;
  cameraBookmarks: CameraBookmark[];
  time: TimeState;
  materials: Record<string, Material>;
  assets: ProjectAssetRef[];
  selection: SelectionEntry[];
  stats: SceneStats;
  runtimeDebug: RuntimeDebugState;
  dirty: boolean;
  statusMessage: string;
  consoleEntries: ConsoleEntry[];
  actorStatusByActorId: Record<string, ActorRuntimeStatus>;
}


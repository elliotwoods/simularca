import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsLeftRight,
  faBackwardStep,
  faCircle,
  faCircleDot,
  faClone,
  faForwardStep,
  faPause,
  faPlay,
  faRotateLeft,
  faStop,
  faToggleOff,
  faToggleOn,
  faTrashCan,
  faXmark
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { DEFAULT_POST_PROCESSING } from "@/core/defaults";
import type {
  ActorNode,
  ActorRuntimeStatus,
  ActorVisibilityMode,
  AppState,
  ComponentNode,
  FileParameterDefinition,
  Material,
  ParameterDefinition,
  ParameterValue,
  ParameterValues,
  RenderEngine,
  SceneToneMappingMode
} from "@/core/types";
import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import {
  appendCurvePoint,
  duplicateCurvePoint,
  removeCurvePoint,
  setCurveAnchorPosition,
  setCurvePointEnabled,
  setCurveHandleWeightMode,
  setCurvePointMode
} from "@/features/curves/editing";
import { curveDataWithOverrides, getCurveTypeFromActor } from "@/features/curves/model";
import {
  appendCameraPathCurvePoint,
  clampCameraPathKeyframeTime,
  createCameraPathKeyframe,
  getCameraPathDurationSeconds,
  getCameraPathKeyframeIndexAtTime,
  getCameraPathKeyframes,
  getCameraPathTimeAtKeyframeIndex,
  getCameraPathKeyframeCount,
  getCameraPathValidity,
  resolveCameraPathRefs,
  sampleCameraPathPoseAtTime
} from "@/features/cameraPath/model";
import { importFileForActorParam } from "@/features/imports/fileParameterImport";
import { StatsBlock } from "@/ui/components/StatsBlock";
import type { StatsGroup, StatsRow } from "@/ui/components/StatsBlock";
import {
  ActorRefField,
  ActorRefListField,
  ColorField,
  DigitScrubInput,
  DrillInRow,
  FileField,
  NumberField,
  SegmentedControl,
  SelectField,
  TextField,
  ToggleField,
  MaterialRefField
} from "@/ui/widgets";
import type { ReferencePickerOption } from "@/ui/widgets/ReferencePicker";

type BindingValue = ParameterValue;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const VISIBILITY_OPTIONS: ActorVisibilityMode[] = ["visible", "hidden", "selected"];
const DEFAULT_SCENE_BACKGROUND = "#070b12";
const DEFAULT_CAMERA_KEYBOARD_NAVIGATION = true;
const DEFAULT_CAMERA_NAVIGATION_SPEED = 6;
const DEFAULT_CAMERA_FOV_DEGREES = 50;
const DEFAULT_SLOW_FRAME_DIAGNOSTICS_ENABLED = false;
const DEFAULT_SLOW_FRAME_DIAGNOSTICS_THRESHOLD_MS = 100;
const CURVE_VERTEX_SELECT_EVENT = "simularca:curve-vertex-select";
const NAVIGATE_BACK_REQUEST_EVENT = "simularca:navigate-back-request";
const NAVIGATE_FORWARD_REQUEST_EVENT = "simularca:navigate-forward-request";
type CurveControlType = "anchor" | "handleIn" | "handleOut";
const CURVE_HANDLE_MODE_OPTIONS = [
  {
    value: "auto",
    label: "Auto Anchors",
    title: "Neighbor-aware automatic handles",
    icon: <FontAwesomeIcon icon={faCircleDot} />
  },
  {
    value: "mirrored",
    label: "Mirrored Handles",
    title: "Mirrored handles (symmetric)",
    icon: <FontAwesomeIcon icon={faArrowsLeftRight} />
  },
  {
    value: "normal",
    label: "Independent",
    title: "Independent in/out handle weights",
    icon: <FontAwesomeIcon icon={faCircle} />
  }
] as const;
const CURVE_WEIGHT_MODE_OPTIONS = [
  {
    value: "normal",
    label: "On",
    title: "Weighted handle enabled",
    icon: <FontAwesomeIcon icon={faCircleDot} />
  },
  {
    value: "hard",
    label: "Off",
    title: "Weighted handle disabled",
    icon: <FontAwesomeIcon icon={faXmark} />
  }
] as const;
const SCENE_ENGINE_OPTIONS: Array<{ value: RenderEngine; label: string }> = [
  { value: "webgl2", label: "WebGL2" },
  { value: "webgpu", label: "WebGPU" }
];
const SCENE_TONEMAPPING_OPTIONS: Array<{ value: SceneToneMappingMode; label: string }> = [
  { value: "aces", label: "ACES" },
  { value: "off", label: "Off" }
];

function resolveActorDescriptor(
  actor: ActorNode,
  descriptors: ReloadableDescriptor[]
): ReloadableDescriptor | undefined {
  return descriptors.find((descriptor) => {
    if (!descriptor.spawn) {
      return false;
    }
    if (descriptor.spawn.actorType !== actor.actorType) {
      return false;
    }
    return descriptor.spawn.pluginType === actor.pluginType;
  });
}

function inferParamType(value: BindingValue): "number" | "boolean" | "string" {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
}

function getFallbackDefinitionsFromParams(params: ParameterValues): ParameterDefinition[] {
  return Object.entries(params).map(([key, value]) => ({
    key,
    label: key,
    type: inferParamType(value)
  }));
}

function getParameterDefinitions(actor: ActorNode, descriptors: ReloadableDescriptor[]): ParameterDefinition[] {
  const descriptor = resolveActorDescriptor(actor, descriptors);
  const schemaParams = descriptor?.schema.params ?? [];
  if (schemaParams.length > 0) {
    return schemaParams;
  }
  return getFallbackDefinitionsFromParams(actor.params);
}

function formatStatusKeyLabel(key: string): string {
  if (!key) {
    return key;
  }
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!withSpaces) {
    return key;
  }
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function getDefaultStatusEntries(actor: ActorNode, runtimeStatus?: ActorRuntimeStatus): ActorStatusEntry[] {
  const baseEntries: ActorStatusEntry[] = [
    { label: "Type", value: actor.actorType },
    { label: "Enabled", value: actor.enabled },
    { label: "Children", value: actor.childActorIds.length },
    { label: "Components", value: actor.componentIds.length }
  ];

  if (!runtimeStatus) {
    return baseEntries;
  }

  const runtimeEntries: ActorStatusEntry[] = Object.entries(runtimeStatus.values).map(([key, value]) => ({
    label: formatStatusKeyLabel(key),
    value: value as ActorStatusEntry["value"]
  }));

  return [
    ...baseEntries,
    ...runtimeEntries,
    { label: "Updated", value: runtimeStatus.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : null },
    { label: "Error", value: runtimeStatus.error ?? null, tone: "error" }
  ];
}

function formatStatusValue(value: ActorStatusEntry["value"]): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === "string") {
      return (value as string[]).join(", ");
    }
    const nums = value as [number, number, number];
    return `${nums[0].toFixed(3)}, ${nums[1].toFixed(3)}, ${nums[2].toFixed(3)}`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

function groupStatusLabel(label: string): string {
  if (label === "Type" || label === "Enabled" || label === "Children" || label === "Components" || label === "Load State") {
    return "Core";
  }
  if (label === "Updated" || label === "Error") {
    return "Meta";
  }
  if (
    label === "Sim Time Seconds" ||
    label === "Dt Seconds" ||
    label === "Time Advancing" ||
    label === "Motion Phase Raw" ||
    label === "Motion Phase Wrapped" ||
    label === "Motion Angular" ||
    label === "Motion Sine" ||
    label === "Motion Turns Applied" ||
    label.startsWith("Wheel Motion ")
  ) {
    return "Motion";
  }
  if (
    label === "Wheel Rotation Deg" ||
    label === "Wheel Base Rotation Deg" ||
    label === "Expected Vs Current Angle Deg" ||
    label === "Base Reconciled This Frame" ||
    label === "Pin Radius"
  ) {
    return "Wheel";
  }
  if (label.startsWith("Thread ") || label.startsWith("First ") || label === "Pulley Lines") {
    return "Thread";
  }
  if (label.startsWith("Pivot ")) {
    return "Pivot";
  }
  if (label.startsWith("Pin ")) {
    return "Pins";
  }
  return "Other";
}

function buildStatusGroups(rows: StatsRow[]): StatsGroup[] {
  const order = ["Core", "Motion", "Wheel", "Thread", "Pivot", "Pins", "Meta", "Other"];
  const grouped = new Map<string, StatsRow[]>();
  for (const row of rows) {
    const bucket = groupStatusLabel(row.label);
    const existing = grouped.get(bucket);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(bucket, [row]);
    }
  }
  return order
    .map((label) => ({ label, rows: grouped.get(label) ?? [] }))
    .filter((group) => group.rows.length > 0);
}

function defaultValueForDefinition(definition: ParameterDefinition): BindingValue {
  if (definition.defaultValue !== undefined) {
    return definition.defaultValue;
  }
  if (definition.type === "number") {
    return 0;
  }
  if (definition.type === "boolean") {
    return false;
  }
  if (definition.type === "color") {
    return "#000000";
  }
  if (definition.type === "select") {
    return definition.options[0] ?? "";
  }
  if (definition.type === "actor-ref-list") {
    return [];
  }
  return "";
}

function bindingValueFor(definition: ParameterDefinition, actor: ActorNode): BindingValue {
  const value = actor.params[definition.key];
  if (value !== undefined) {
    return value;
  }
  return defaultValueForDefinition(definition);
}

function isDefinitionVisibleForActor(
  definition: ParameterDefinition,
  actor: ActorNode,
  definitions: ParameterDefinition[]
): boolean {
  const rules = definition.visibleWhen;
  if (!rules || rules.length === 0) {
    return true;
  }
  return rules.every((rule) => {
    const value = actor.params[rule.key];
    const controllingDefinition = definitions.find((candidate) => candidate.key === rule.key);
    const effectiveValue = value !== undefined ? value : controllingDefinition ? defaultValueForDefinition(controllingDefinition) : undefined;
    return effectiveValue === rule.equals;
  });
}

const BEAM_SHADER_GROUP_KEY = "__beam-shader__";
const BEAM_SHADER_GROUP_LABEL = "Shader Properties";
const BEAM_SHADER_PARAM_KEYS = new Set([
  "beamType",
  "beamColor",
  "beamAlpha",
  "alongBeamPower",
  "scatteringFactor",
  "hazeIntensity",
  "scatteringCoeff",
  "extinctionCoeff",
  "anisotropyG",
  "beamDivergenceRad",
  "beamApertureDiameter",
  "distanceFalloffExponent",
  "pathLengthGain",
  "pathLengthExponent",
  "phaseGain",
  "scanDuty",
  "nearFadeStart",
  "nearFadeEnd",
  "softClampKnee"
]);

function isBeamEmitterSelection(actorSelection: ActorNode[]): boolean {
  return actorSelection.length > 0 && actorSelection.every((actor) =>
    actor.actorType === "plugin" &&
    (actor.pluginType === "plugin.beamCrossover.emitter" || actor.pluginType === "plugin.beamCrossover.emitterArray")
  );
}

function isBeamShaderDefinition(definition: ParameterDefinition): boolean {
  return BEAM_SHADER_PARAM_KEYS.has(definition.key);
}

function commonDefinitionsForGroup(
  actorSelection: ActorNode[],
  descriptors: ReloadableDescriptor[]
): ParameterDefinition[] {
  const firstActor = actorSelection[0];
  if (!firstActor) {
    return [];
  }
  const firstActorDefinitions = getParameterDefinitions(firstActor, descriptors);
  const firstDefinitions = firstActorDefinitions.filter((definition) =>
    isDefinitionVisibleForActor(definition, firstActor, firstActorDefinitions)
  );
  const otherDefinitionsByActor = actorSelection.slice(1).map((actor) => {
    const actorDefinitions = getParameterDefinitions(actor, descriptors);
    return new Map(
      actorDefinitions
        .filter((definition) => isDefinitionVisibleForActor(definition, actor, actorDefinitions))
        .map((definition) => [definition.key, definition])
    );
  });

  return firstDefinitions.filter((definition) =>
    otherDefinitionsByActor.every((definitions) => definitions.get(definition.key)?.type === definition.type)
  );
}

function isMixedValue(values: BindingValue[]): boolean {
  const first = values[0];
  if (first === undefined) {
    return false;
  }
  return values.some((value) => !bindingValuesEqual(value, first));
}

function bindingValuesEqual(a: BindingValue, b: BindingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((entry, index) => entry === b[index]);
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return a === b;
}

function isMixedNumber(values: number[]): boolean {
  const first = values[0];
  if (first === undefined) {
    return false;
  }
  return values.some((value) => Math.abs(value - first) > 1e-9);
}

function coerceFiniteNumber(value: BindingValue, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function allActorsMatch(actorSelection: ActorNode[], predicate: (actor: ActorNode) => boolean): boolean {
  return actorSelection.every(predicate);
}

function buildFileFilters(definition: FileParameterDefinition): { name: string; extensions: string[] }[] {
  const extensions = definition.accept
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."))
    .map((extension) => extension.slice(1))
    .filter((extension) => extension.length > 0);

  if (extensions.length === 0) {
    return [];
  }

  return [
    {
      name: definition.label,
      extensions
    }
  ];
}

async function pickFileFromDialog(definition: FileParameterDefinition): Promise<string | null> {
  if (!window.electronAPI) {
    return null;
  }
  return window.electronAPI.openFileDialog({
    title: definition.dialogTitle ?? `Select ${definition.label}`,
    filters: buildFileFilters(definition)
  });
}

function actorRefOptionsForDefinition(
  definition: Extract<ParameterDefinition, { type: "actor-ref" | "actor-ref-list" }>,
  actors: Record<string, ActorNode>,
  selectedActors: ActorNode[]
): ReferencePickerOption[] {
  const selectedIds = new Set(selectedActors.map((actor) => actor.id));
  return Object.values(actors)
    .filter((actor) => {
      if (!definition.allowSelf && selectedIds.has(actor.id)) {
        return false;
      }
      if (definition.allowedActorTypes && definition.allowedActorTypes.length > 0) {
        return definition.allowedActorTypes.includes(actor.actorType);
      }
      return true;
    })
    .map((actor) => ({
      id: actor.id,
      label: actor.name,
      detail: `${actor.actorType}${actor.enabled ? "" : " · disabled"} · ${actor.id.slice(0, 8)}`,
      kindLabel: actor.actorType.toUpperCase(),
      searchText: `${actor.name} ${actor.actorType} ${actor.id}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

interface SceneInspectorViewProps {
  appState: AppState;
  readOnly: boolean;
  sceneBackgroundInput: string;
  setSceneBackgroundInput: (next: string) => void;
  kernel: ReturnType<typeof useKernel>;
}

type SceneInspectorRoute = "root" | "engine" | "camera" | "post-processing" | "diagnostics";

function cloneInspectorView<T>(view: T): T {
  return { ...view };
}

function inspectorViewsEqual(
  a: { kind: "actor-root" } | { kind: "component"; componentId: string; componentLabel: string } | { kind: "param-group"; paramKey: string; paramLabel: string; fromComponentId: string | null },
  b: { kind: "actor-root" } | { kind: "component"; componentId: string; componentLabel: string } | { kind: "param-group"; paramKey: string; paramLabel: string; fromComponentId: string | null }
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function SceneInspectorView(props: SceneInspectorViewProps) {
  const [sceneInspectorView, setSceneInspectorView] = useState<SceneInspectorRoute>("root");
  const sceneBackHistoryRef = useRef<SceneInspectorRoute[]>([]);
  const sceneForwardHistoryRef = useRef<SceneInspectorRoute[]>([]);
  const sceneHistorySuppressRef = useRef(false);
  const previousSceneInspectorViewRef = useRef<SceneInspectorRoute>("root");
  const environmentActor = Object.values(props.appState.actors).find((actor) => actor.actorType === "environment");
  const hasEnvironmentBackground =
    typeof environmentActor?.params.assetId === "string" && environmentActor.params.assetId.length > 0;
  const canResetBackground = props.appState.scene.backgroundColor.toLowerCase() !== DEFAULT_SCENE_BACKGROUND;
  const canResetEngine = props.appState.scene.renderEngine !== "webgl2";
  const canResetAntialiasing = props.appState.scene.antialiasing !== true;
  const canResetTonemappingMode = props.appState.scene.tonemapping.mode !== "aces";
  const canResetTonemappingDither = props.appState.scene.tonemapping.dither !== true;
  const canResetBloomEnabled = props.appState.scene.postProcessing.bloom.enabled !== DEFAULT_POST_PROCESSING.bloom.enabled;
  const canResetBloomStrength =
    Math.abs(props.appState.scene.postProcessing.bloom.strength - DEFAULT_POST_PROCESSING.bloom.strength) > 1e-9;
  const canResetBloomRadius =
    Math.abs(props.appState.scene.postProcessing.bloom.radius - DEFAULT_POST_PROCESSING.bloom.radius) > 1e-9;
  const canResetBloomThreshold =
    Math.abs(props.appState.scene.postProcessing.bloom.threshold - DEFAULT_POST_PROCESSING.bloom.threshold) > 1e-9;
  const canResetVignetteEnabled =
    props.appState.scene.postProcessing.vignette.enabled !== DEFAULT_POST_PROCESSING.vignette.enabled;
  const canResetVignetteOffset =
    Math.abs(props.appState.scene.postProcessing.vignette.offset - DEFAULT_POST_PROCESSING.vignette.offset) > 1e-9;
  const canResetVignetteDarkness =
    Math.abs(props.appState.scene.postProcessing.vignette.darkness - DEFAULT_POST_PROCESSING.vignette.darkness) > 1e-9;
  const canResetChromaticAberrationEnabled =
    props.appState.scene.postProcessing.chromaticAberration.enabled !==
    DEFAULT_POST_PROCESSING.chromaticAberration.enabled;
  const canResetChromaticAberrationOffset =
    Math.abs(
      props.appState.scene.postProcessing.chromaticAberration.offset - DEFAULT_POST_PROCESSING.chromaticAberration.offset
    ) > 1e-9;
  const canResetGrainEnabled = props.appState.scene.postProcessing.grain.enabled !== DEFAULT_POST_PROCESSING.grain.enabled;
  const canResetGrainIntensity =
    Math.abs(props.appState.scene.postProcessing.grain.intensity - DEFAULT_POST_PROCESSING.grain.intensity) > 1e-9;
  const canResetKeyboardNavigation =
    props.appState.scene.cameraKeyboardNavigation !== DEFAULT_CAMERA_KEYBOARD_NAVIGATION;
  const canResetNavigationSpeed =
    Math.abs(props.appState.scene.cameraNavigationSpeed - DEFAULT_CAMERA_NAVIGATION_SPEED) > 1e-9;
  const canResetCameraFov = Math.abs(props.appState.camera.fov - DEFAULT_CAMERA_FOV_DEGREES) > 1e-9;
  const canResetSlowFrameDiagnosticsEnabled =
    props.appState.runtimeDebug.slowFrameDiagnosticsEnabled !== DEFAULT_SLOW_FRAME_DIAGNOSTICS_ENABLED;
  const canResetSlowFrameDiagnosticsThreshold =
    Math.abs(
      props.appState.runtimeDebug.slowFrameDiagnosticsThresholdMs - DEFAULT_SLOW_FRAME_DIAGNOSTICS_THRESHOLD_MS
    ) > 1e-9;
  const postProcessingEnabledCount = [
    props.appState.scene.postProcessing.bloom.enabled,
    props.appState.scene.postProcessing.vignette.enabled,
    props.appState.scene.postProcessing.chromaticAberration.enabled,
    props.appState.scene.postProcessing.grain.enabled
  ].filter(Boolean).length;
  const engineSummary = `${props.appState.scene.renderEngine === "webgl2" ? "WebGL2" : "WebGPU"} · ${
    props.appState.scene.tonemapping.mode === "aces" ? "ACES" : "Tone Off"
  }`;
  const cameraSummary =
    props.appState.camera.mode === "orthographic"
      ? `Zoom ${props.appState.camera.zoom.toFixed(2)}`
      : `FOV ${props.appState.camera.fov.toFixed(1)}°`;
  const postProcessingSummary = postProcessingEnabledCount > 0 ? `${postProcessingEnabledCount} enabled` : "All off";
  const diagnosticsSummary = props.appState.runtimeDebug.slowFrameDiagnosticsEnabled
    ? `Slow frames on · ${props.appState.runtimeDebug.slowFrameDiagnosticsThresholdMs.toFixed(0)} ms`
    : "Slow frames off";
  const handleSceneBack = useCallback((): boolean => {
    const previousRoute = sceneBackHistoryRef.current.pop();
    if (!previousRoute) {
      return false;
    }
    if ((sceneForwardHistoryRef.current.at(-1) ?? null) !== sceneInspectorView) {
      sceneForwardHistoryRef.current.push(sceneInspectorView);
    }
    sceneHistorySuppressRef.current = true;
    setSceneInspectorView(previousRoute);
    return true;
  }, [sceneInspectorView]);
  const handleSceneForward = useCallback((): boolean => {
    const nextRoute = sceneForwardHistoryRef.current.pop();
    if (!nextRoute) {
      return false;
    }
    if ((sceneBackHistoryRef.current.at(-1) ?? null) !== sceneInspectorView) {
      sceneBackHistoryRef.current.push(sceneInspectorView);
    }
    sceneHistorySuppressRef.current = true;
    setSceneInspectorView(nextRoute);
    return true;
  }, [sceneInspectorView]);
  const sceneStatsRows = [
    { label: "FPS", value: Number.isFinite(props.appState.stats.fps) ? props.appState.stats.fps.toFixed(1) : "0.0" },
    {
      label: "Frame (ms)",
      value: Number.isFinite(props.appState.stats.frameMs) ? props.appState.stats.frameMs.toFixed(2) : "0.00"
    },
    {
      label: "Camera Mode",
      value: props.appState.camera.mode === "orthographic" ? "Orthographic" : "Perspective"
    },
    {
      label: "Camera Position (m)",
      value: `${props.appState.camera.position[0].toFixed(3)}, ${props.appState.camera.position[1].toFixed(3)}, ${props.appState.camera.position[2].toFixed(3)}`
    },
    {
      label: "Camera Target (m)",
      value: `${props.appState.camera.target[0].toFixed(3)}, ${props.appState.camera.target[1].toFixed(3)}, ${props.appState.camera.target[2].toFixed(3)}`
    },
    {
      label: props.appState.camera.mode === "orthographic" ? "Camera Zoom" : "Camera FOV",
      value:
        props.appState.camera.mode === "orthographic"
          ? props.appState.camera.zoom.toFixed(3)
          : `${props.appState.camera.fov.toFixed(2)} deg`
    },
    {
      label: "Camera Distance (m)",
      value: Number.isFinite(props.appState.stats.cameraDistance) ? props.appState.stats.cameraDistance.toFixed(3) : "0.000"
    },
    { label: "Controls Enabled", value: props.appState.stats.cameraControlsEnabled ? "Yes" : "No" },
    { label: "Zoom Enabled", value: props.appState.stats.cameraZoomEnabled ? "Yes" : "No" },
    { label: "Draw Calls", value: Math.max(0, Math.floor(props.appState.stats.drawCalls)).toLocaleString() },
    { label: "Triangles", value: Math.max(0, Math.floor(props.appState.stats.triangles)).toLocaleString() },
    { label: "Splat Draw Calls", value: Math.max(0, Math.floor(props.appState.stats.splatDrawCalls)).toLocaleString() },
    { label: "Splat Triangles", value: Math.max(0, Math.floor(props.appState.stats.splatTriangles)).toLocaleString() },
    { label: "Visible Splats", value: Math.max(0, Math.floor(props.appState.stats.splatVisibleCount)).toLocaleString() },
    { label: "Resource (MB)", value: Number.isFinite(props.appState.stats.resourceMb) ? props.appState.stats.resourceMb.toFixed(1) : "0.0" },
    { label: "Heap (MB)", value: Number.isFinite(props.appState.stats.heapMb) ? props.appState.stats.heapMb.toFixed(1) : "0.0" },
    { label: "Actor Count", value: Math.max(0, Math.floor(props.appState.stats.actorCount)).toLocaleString() },
    { label: "Enabled Actors", value: Math.max(0, Math.floor(props.appState.stats.actorCountEnabled)).toLocaleString() },
    {
      label: "Project Size",
      value: `${Math.max(0, Math.floor(props.appState.stats.projectFileBytes)).toLocaleString()} B`
    },
    {
      label: "Saved Size",
      value: `${Math.max(0, Math.floor(props.appState.stats.projectFileBytesSaved)).toLocaleString()} B`
    }
  ];

  useEffect(() => {
    const previousRoute = previousSceneInspectorViewRef.current;
    if (previousRoute === sceneInspectorView) {
      return;
    }
    if (sceneHistorySuppressRef.current) {
      sceneHistorySuppressRef.current = false;
      previousSceneInspectorViewRef.current = sceneInspectorView;
      return;
    }
    if ((sceneBackHistoryRef.current.at(-1) ?? null) !== previousRoute) {
      sceneBackHistoryRef.current.push(previousRoute);
    }
    sceneForwardHistoryRef.current = [];
    previousSceneInspectorViewRef.current = sceneInspectorView;
  }, [sceneInspectorView]);

  useEffect(() => {
    const onBackRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ handled?: boolean }>;
      if (customEvent.detail?.handled) {
        return;
      }
      if (handleSceneBack()) {
        if (customEvent.detail) {
          customEvent.detail.handled = true;
        }
      }
    };
    window.addEventListener(NAVIGATE_BACK_REQUEST_EVENT, onBackRequest);
    return () => {
      window.removeEventListener(NAVIGATE_BACK_REQUEST_EVENT, onBackRequest);
    };
  }, [handleSceneBack]);

  useEffect(() => {
    const onForwardRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ handled?: boolean }>;
      if (customEvent.detail?.handled) {
        return;
      }
      if (handleSceneForward()) {
        if (customEvent.detail) {
          customEvent.detail.handled = true;
        }
      }
    };
    window.addEventListener(NAVIGATE_FORWARD_REQUEST_EVENT, onForwardRequest);
    return () => {
      window.removeEventListener(NAVIGATE_FORWARD_REQUEST_EVENT, onForwardRequest);
    };
  }, [handleSceneForward]);

  return (
    <div className="inspector-pane-root custom-inspector">
      {sceneInspectorView !== "root" ? (
        <div className="inspector-nav-header">
          <button className="inspector-nav-back" onClick={() => setSceneInspectorView("root")}>‹</button>
          <nav className="inspector-breadcrumb">
            <button className="inspector-breadcrumb-segment" onClick={() => setSceneInspectorView("root")}>
              Scene
            </button>
            <span className="inspector-breadcrumb-sep">›</span>
            <span className="inspector-breadcrumb-current">
              {sceneInspectorView === "engine"
                ? "Engine"
                : sceneInspectorView === "camera"
                  ? "Camera"
                  : sceneInspectorView === "post-processing"
                    ? "Post Processing"
                    : "Diagnostics"}
            </span>
          </nav>
        </div>
      ) : null}
      {sceneInspectorView === "root" ? (
      <section className="inspector-common-card">
        <header>
          <h4>Scene</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Name</span>
            <span className="inspector-scene-value">{props.appState.scene.name}</span>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Background</span>
            <div className="inspector-common-control-wrap">
              <div className="inspector-scene-color-row">
                <input
                  type="color"
                  className="inspector-color-input"
                  value={props.appState.scene.backgroundColor}
                  disabled={props.readOnly || hasEnvironmentBackground}
                  onChange={(event) => {
                    const color = event.target.value;
                    props.setSceneBackgroundInput(color);
                    props.kernel.store.getState().actions.setSceneBackgroundColor(color);
                  }}
                />
                <input
                  type="text"
                  className="widget-text"
                  value={props.sceneBackgroundInput}
                  disabled={props.readOnly || hasEnvironmentBackground}
                  onChange={(event) => {
                    const next = event.target.value;
                    props.setSceneBackgroundInput(next);
                    if (/^#[0-9a-fA-F]{6}$/.test(next) || /^#[0-9a-fA-F]{3}$/.test(next)) {
                      props.kernel.store.getState().actions.setSceneBackgroundColor(next);
                    }
                  }}
                />
              </div>
              <button
                type="button"
                className={`widget-reset-button${canResetBackground ? "" : " is-hidden"}`}
                title="Reset Background"
                disabled={props.readOnly || hasEnvironmentBackground || !canResetBackground}
                onClick={() => {
                  props.setSceneBackgroundInput(DEFAULT_SCENE_BACKGROUND);
                  props.kernel.store.getState().actions.setSceneBackgroundColor(DEFAULT_SCENE_BACKGROUND);
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
        {hasEnvironmentBackground ? (
          <p className="panel-empty">Background color is overridden while an Environment texture is active.</p>
        ) : null}
      </section>
      ) : null}
      {sceneInspectorView === "root" ? (
        <section className="inspector-common-card">
          <header>
            <h4>Settings</h4>
          </header>
          <DrillInRow label="Engine" summary={engineSummary} onClick={() => setSceneInspectorView("engine")} />
          <DrillInRow label="Camera" summary={cameraSummary} onClick={() => setSceneInspectorView("camera")} />
          <DrillInRow
            label="Post Processing"
            summary={postProcessingSummary}
            onClick={() => setSceneInspectorView("post-processing")}
          />
          <DrillInRow
            label="Diagnostics"
            summary={diagnosticsSummary}
            onClick={() => setSceneInspectorView("diagnostics")}
          />
        </section>
      ) : null}
      {sceneInspectorView === "engine" ? (
      <section className="inspector-common-card">
        <header>
          <h4>Engine</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Engine</span>
            <div className="inspector-common-control-wrap">
              <select
                className="widget-select"
                value={props.appState.scene.renderEngine}
                disabled={props.readOnly}
                onChange={(event) => {
                  const value = event.target.value === "webgpu" ? "webgpu" : "webgl2";
                  props.kernel.store.getState().actions.setSceneRenderSettings({ renderEngine: value });
                }}
              >
                {SCENE_ENGINE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`widget-reset-button${canResetEngine ? "" : " is-hidden"}`}
                title="Reset Engine"
                disabled={props.readOnly || !canResetEngine}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({ renderEngine: "webgl2" });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Anti-Aliasing</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.antialiasing}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    antialiasing: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetAntialiasing ? "" : " is-hidden"}`}
                title="Reset Anti-Aliasing"
                disabled={props.readOnly || !canResetAntialiasing}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    antialiasing: true
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Tonemapping</span>
            <div className="inspector-common-control-wrap">
              <select
                className="widget-select"
                value={props.appState.scene.tonemapping.mode}
                disabled={props.readOnly}
                onChange={(event) => {
                  const value = event.target.value === "off" ? "off" : "aces";
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    tonemapping: {
                      mode: value
                    }
                  });
                }}
              >
                {SCENE_TONEMAPPING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`widget-reset-button${canResetTonemappingMode ? "" : " is-hidden"}`}
                title="Reset Tonemapping"
                disabled={props.readOnly || !canResetTonemappingMode}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    tonemapping: {
                      mode: "aces"
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Dither 8-bit Output</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.tonemapping.dither}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    tonemapping: {
                      dither: next
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetTonemappingDither ? "" : " is-hidden"}`}
                title="Reset Output Dither"
                disabled={props.readOnly || !canResetTonemappingDither}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    tonemapping: {
                      dither: true
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
      </section>
      ) : null}
      {sceneInspectorView === "post-processing" ? (
      <section className="inspector-common-card">
        <header>
          <h4>Post Processing</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Bloom</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.postProcessing.bloom.enabled}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        enabled: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetBloomEnabled ? "" : " is-hidden"}`}
                title="Reset Bloom"
                disabled={props.readOnly || !canResetBloomEnabled}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        enabled: DEFAULT_POST_PROCESSING.bloom.enabled
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Bloom Strength</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.bloom.strength}
                min={0}
                step={0.05}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        strength: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetBloomStrength ? "" : " is-hidden"}`}
                title="Reset Bloom Strength"
                disabled={props.readOnly || !canResetBloomStrength}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        strength: DEFAULT_POST_PROCESSING.bloom.strength
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Bloom Radius</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.bloom.radius}
                min={0}
                step={0.01}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        radius: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetBloomRadius ? "" : " is-hidden"}`}
                title="Reset Bloom Radius"
                disabled={props.readOnly || !canResetBloomRadius}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        radius: DEFAULT_POST_PROCESSING.bloom.radius
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Bloom Threshold</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.bloom.threshold}
                min={0}
                step={0.01}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        threshold: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetBloomThreshold ? "" : " is-hidden"}`}
                title="Reset Bloom Threshold"
                disabled={props.readOnly || !canResetBloomThreshold}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      bloom: {
                        threshold: DEFAULT_POST_PROCESSING.bloom.threshold
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Vignette</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.postProcessing.vignette.enabled}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        enabled: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetVignetteEnabled ? "" : " is-hidden"}`}
                title="Reset Vignette"
                disabled={props.readOnly || !canResetVignetteEnabled}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        enabled: DEFAULT_POST_PROCESSING.vignette.enabled
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Vignette Offset</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.vignette.offset}
                min={0}
                step={0.01}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        offset: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetVignetteOffset ? "" : " is-hidden"}`}
                title="Reset Vignette Offset"
                disabled={props.readOnly || !canResetVignetteOffset}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        offset: DEFAULT_POST_PROCESSING.vignette.offset
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Vignette Darkness</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.vignette.darkness}
                min={0}
                max={1}
                step={0.01}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        darkness: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetVignetteDarkness ? "" : " is-hidden"}`}
                title="Reset Vignette Darkness"
                disabled={props.readOnly || !canResetVignetteDarkness}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      vignette: {
                        darkness: DEFAULT_POST_PROCESSING.vignette.darkness
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Chromatic Aberration</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.postProcessing.chromaticAberration.enabled}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      chromaticAberration: {
                        enabled: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetChromaticAberrationEnabled ? "" : " is-hidden"}`}
                title="Reset Chromatic Aberration"
                disabled={props.readOnly || !canResetChromaticAberrationEnabled}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      chromaticAberration: {
                        enabled: DEFAULT_POST_PROCESSING.chromaticAberration.enabled
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Chromatic Offset</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.chromaticAberration.offset}
                min={0}
                step={0.0001}
                precision={4}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      chromaticAberration: {
                        offset: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetChromaticAberrationOffset ? "" : " is-hidden"}`}
                title="Reset Chromatic Offset"
                disabled={props.readOnly || !canResetChromaticAberrationOffset}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      chromaticAberration: {
                        offset: DEFAULT_POST_PROCESSING.chromaticAberration.offset
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Film Grain</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.postProcessing.grain.enabled}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      grain: {
                        enabled: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetGrainEnabled ? "" : " is-hidden"}`}
                title="Reset Film Grain"
                disabled={props.readOnly || !canResetGrainEnabled}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      grain: {
                        enabled: DEFAULT_POST_PROCESSING.grain.enabled
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Grain Intensity</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.postProcessing.grain.intensity}
                min={0}
                step={0.005}
                precision={3}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      grain: {
                        intensity: next
                      }
                    }
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetGrainIntensity ? "" : " is-hidden"}`}
                title="Reset Grain Intensity"
                disabled={props.readOnly || !canResetGrainIntensity}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    postProcessing: {
                      grain: {
                        intensity: DEFAULT_POST_PROCESSING.grain.intensity
                      }
                    }
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
      </section>
      ) : null}
      {sceneInspectorView === "camera" ? (
      <section className="inspector-common-card">
        <header>
          <h4>Camera</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Keyboard Camera Nav</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.scene.cameraKeyboardNavigation}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    cameraKeyboardNavigation: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetKeyboardNavigation ? "" : " is-hidden"}`}
                title="Reset Keyboard Navigation"
                disabled={props.readOnly || !canResetKeyboardNavigation}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    cameraKeyboardNavigation: DEFAULT_CAMERA_KEYBOARD_NAVIGATION
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Camera Nav Speed (m/s)</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.scene.cameraNavigationSpeed}
                min={0}
                step={0.1}
                precision={2}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    cameraNavigationSpeed: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetNavigationSpeed ? "" : " is-hidden"}`}
                title="Reset Camera Navigation Speed"
                disabled={props.readOnly || !canResetNavigationSpeed}
                onClick={() => {
                  props.kernel.store.getState().actions.setSceneRenderSettings({
                    cameraNavigationSpeed: DEFAULT_CAMERA_NAVIGATION_SPEED
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Camera FOV (deg)</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.camera.fov}
                min={5}
                max={170}
                step={0.1}
                precision={1}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setCameraState({
                    fov: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetCameraFov ? "" : " is-hidden"}`}
                title="Reset Camera FOV"
                disabled={props.readOnly || !canResetCameraFov}
                onClick={() => {
                  props.kernel.store.getState().actions.setCameraState({
                    fov: DEFAULT_CAMERA_FOV_DEGREES
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
      </section>
      ) : null}
      {sceneInspectorView === "diagnostics" ? (
      <section className="inspector-common-card">
        <header>
          <h4>Diagnostics</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Slow Frame Logging</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={props.appState.runtimeDebug.slowFrameDiagnosticsEnabled}
                disabled={props.readOnly}
                embedded
                onChange={(next) => {
                  props.kernel.store.getState().actions.setRuntimeDebugSettings({
                    slowFrameDiagnosticsEnabled: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetSlowFrameDiagnosticsEnabled ? "" : " is-hidden"}`}
                title="Reset Slow Frame Logging"
                disabled={props.readOnly || !canResetSlowFrameDiagnosticsEnabled}
                onClick={() => {
                  props.kernel.store.getState().actions.setRuntimeDebugSettings({
                    slowFrameDiagnosticsEnabled: DEFAULT_SLOW_FRAME_DIAGNOSTICS_ENABLED
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Slow Frame Threshold (ms)</span>
            <div className="inspector-common-control-wrap">
              <NumberField
                label=""
                value={props.appState.runtimeDebug.slowFrameDiagnosticsThresholdMs}
                min={1}
                step={1}
                precision={0}
                disabled={props.readOnly}
                onChange={(next) => {
                  props.kernel.store.getState().actions.setRuntimeDebugSettings({
                    slowFrameDiagnosticsThresholdMs: next
                  });
                }}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetSlowFrameDiagnosticsThreshold ? "" : " is-hidden"}`}
                title="Reset Slow Frame Threshold"
                disabled={props.readOnly || !canResetSlowFrameDiagnosticsThreshold}
                onClick={() => {
                  props.kernel.store.getState().actions.setRuntimeDebugSettings({
                    slowFrameDiagnosticsThresholdMs: DEFAULT_SLOW_FRAME_DIAGNOSTICS_THRESHOLD_MS
                  });
                }}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
        <p className="panel-empty">Slow frames are logged to the app console when enabled. Browser devtools stay quiet by default.</p>
      </section>
      ) : null}
      {sceneInspectorView === "root" ? (
      <StatsBlock
        title="Status"
        className="inspector-debug-card"
        titleLevel="h4"
        emptyText="No status available."
        rows={sceneStatsRows}
        onCopySuccess={(label) => {
          props.kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
        }}
        onCopyError={(label, message) => {
          props.kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
        }}
      />
      ) : null}
    </div>
  );
}

interface ComponentSelectionInspectorViewProps {
  componentSelection: ComponentNode[];
  componentDefinitions: ParameterDefinition[];
  readOnly: boolean;
  updateSelectedComponentParams: (key: string, nextValue: BindingValue) => void;
}

function ComponentSelectionInspectorView(props: ComponentSelectionInspectorViewProps) {
  return (
    <div className="inspector-pane-root custom-inspector">
      <section className="inspector-common-card">
        <header>
          <h4>Component</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Selection</span>
            <span className="inspector-scene-value">{props.componentSelection.length} component(s)</span>
          </div>
        </div>
      </section>
      {props.componentDefinitions.length === 0 ? (
        <div className="inspector-empty">No common editable params in current selection</div>
      ) : null}
      {props.componentDefinitions.map((definition) => {
        const values = props.componentSelection.map((component) => {
          const value = component.params[definition.key];
          return value !== undefined ? value : defaultValueForDefinition(definition);
        });
        const mixed = isMixedValue(values);
        const current = values[0] ?? defaultValueForDefinition(definition);
        const defaultValue = defaultValueForDefinition(definition);
        const canReset = values.some((value) => !bindingValuesEqual(value, defaultValue));

        if (definition.type === "number") {
          return (
            <NumberField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "number" ? current : 0}
              mixed={mixed}
              min={definition.min}
              max={definition.max}
              step={definition.step}
              precision={definition.precision}
              unit={definition.unit}
              dragSpeed={definition.dragSpeed}
              disabled={props.readOnly}
              showReset={canReset}
              onReset={() => {
                props.updateSelectedComponentParams(definition.key, defaultValue);
              }}
              onChange={(next) => {
                props.updateSelectedComponentParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "boolean") {
          return (
            <ToggleField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              checked={Boolean(current)}
              mixed={mixed}
              disabled={props.readOnly}
              showReset={canReset}
              onReset={() => {
                props.updateSelectedComponentParams(definition.key, Boolean(defaultValue));
              }}
              onChange={(next) => {
                props.updateSelectedComponentParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "color") {
          return (
            <ColorField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : "#000000"}
              mixed={mixed}
              disabled={props.readOnly}
              showReset={canReset}
              onReset={() => {
                props.updateSelectedComponentParams(definition.key, String(defaultValue));
              }}
              onChange={(next) => {
                props.updateSelectedComponentParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "select") {
          return (
            <SelectField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : ""}
              mixed={mixed}
              options={definition.options}
              disabled={props.readOnly}
              showReset={canReset}
              onReset={() => {
                props.updateSelectedComponentParams(definition.key, String(defaultValue));
              }}
              onChange={(next) => {
                props.updateSelectedComponentParams(definition.key, next);
              }}
            />
          );
        }

        return (
          <TextField
            key={definition.key}
            label={definition.label}
            description={definition.description}
            value={typeof current === "string" ? current : ""}
            mixed={mixed}
            disabled={props.readOnly}
            showReset={canReset}
            onReset={() => {
              props.updateSelectedComponentParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
            }}
            onChange={(next) => {
              props.updateSelectedComponentParams(definition.key, next);
            }}
          />
        );
      })}
    </div>
  );
}

export function InspectorPane() {
  const kernel = useKernel();
  const appState = useAppStore((store) => store.state);
  const selection = appState.selection;
  const actors = appState.actors;
  const components = appState.components;
  const assets = appState.assets;
  const actorStatusByActorId = appState.actorStatusByActorId;
  const mode = appState.mode;
  const projectName = appState.activeProjectName;
  const autosaveTimeoutRef = useRef<number | null>(null);

  const actorDescriptors = kernel.descriptorRegistry.listByKind("actor");

  const actorSelection = useMemo(
    () =>
      selection
        .filter((entry) => entry.kind === "actor")
        .map((entry) => actors[entry.id])
        .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor)),
    [selection, actors]
  );
  const componentSelection = useMemo(
    () =>
      selection
        .filter((entry) => entry.kind === "component")
        .map((entry) => components[entry.id])
        .filter((component): component is NonNullable<typeof component> => Boolean(component)),
    [selection, components]
  );

  const definitions = useMemo(() => {
    const first = actorSelection[0];
    if (!first) {
      return [];
    }
    if (actorSelection.length === 1) {
      const firstDefinitions = getParameterDefinitions(first, actorDescriptors);
      return firstDefinitions.filter((definition) =>
        isDefinitionVisibleForActor(definition, first, firstDefinitions)
      );
    }
    return commonDefinitionsForGroup(actorSelection, actorDescriptors);
  }, [actorSelection, actorDescriptors]);
  const hasBeamShaderGroup = isBeamEmitterSelection(actorSelection) && definitions.some(isBeamShaderDefinition);
  const beamTypeDefinition = definitions.find((definition) => definition.key === "beamType");
  const beamTypeValues = beamTypeDefinition ? actorSelection.map((actor) => bindingValueFor(beamTypeDefinition, actor)) : [];
  const beamShaderGroupSummary =
    beamTypeValues.length === 0
      ? undefined
      : isMixedValue(beamTypeValues)
        ? "Mixed"
        : typeof beamTypeValues[0] === "string"
          ? beamTypeValues[0]
          : undefined;
  const componentDefinitions = useMemo(() => {
    const first = componentSelection[0];
    if (!first) {
      return [];
    }
    const firstDefinitions = getFallbackDefinitionsFromParams(first.params);
    const others = componentSelection.slice(1).map((component) => getFallbackDefinitionsFromParams(component.params));
    return firstDefinitions.filter((definition) =>
      others.every((entries) => entries.some((entry) => entry.key === definition.key && entry.type === definition.type))
    );
  }, [componentSelection]);

  const readOnly = mode === "web-ro";
  const [sceneBackgroundInput, setSceneBackgroundInput] = useState(appState.scene.backgroundColor);
  const [selectedCurveVertex, setSelectedCurveVertex] = useState<{ actorId: string; pointIndex: number } | null>(null);
  const [selectedCurveControl, setSelectedCurveControl] = useState<CurveControlType>("anchor");
  const [cameraPathPreviewTimeSeconds, setCameraPathPreviewTimeSeconds] = useState(0);
  const [cameraPathPreviewPlaying, setCameraPathPreviewPlaying] = useState(false);
  const [selectedCameraPathKeyframeId, setSelectedCameraPathKeyframeId] = useState<string | null>(null);
  const cameraPathPlayRafRef = useRef<number | null>(null);
  const cameraPathPlayStartRef = useRef<{ startedAtMs: number; startedTimeSeconds: number } | null>(null);
  const cameraPathTimelineRailRef = useRef<HTMLDivElement | null>(null);
  const cameraPathTimelineDragRef = useRef<{ mode: "playhead" | "keyframe"; keyframeId?: string } | null>(null);

  type InspectorView =
    | { kind: "actor-root" }
    | { kind: "component"; componentId: string; componentLabel: string }
    | { kind: "param-group"; paramKey: string; paramLabel: string; fromComponentId: string | null };
  const [inspectorView, setInspectorView] = useState<InspectorView>({ kind: "actor-root" });
  const inspectorBackHistoryRef = useRef<InspectorView[]>([]);
  const inspectorForwardHistoryRef = useRef<InspectorView[]>([]);
  const inspectorHistorySuppressRef = useRef(false);
  const previousInspectorViewRef = useRef<InspectorView>({ kind: "actor-root" });

  useEffect(() => {
    setSceneBackgroundInput(appState.scene.backgroundColor);
  }, [appState.scene.backgroundColor]);

  useEffect(
    () => () => {
      if (autosaveTimeoutRef.current !== null) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
      if (cameraPathPlayRafRef.current !== null) {
        window.cancelAnimationFrame(cameraPathPlayRafRef.current);
      }
    },
    []
  );

  const scheduleAutosave = () => {
    if (autosaveTimeoutRef.current !== null) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }
    autosaveTimeoutRef.current = window.setTimeout(() => {
      kernel.projectService.queueAutosave();
      autosaveTimeoutRef.current = null;
    }, 120);
  };

  const publishCurveVertexHover = useCallback((actorId: string | null, pointIndex: number | null): void => {
    window.dispatchEvent(
      new CustomEvent("simularca:curve-vertex-hover", {
        detail: {
          actorId,
          pointIndex
        }
      })
    );
  }, []);

  const publishCurveVertexSelect = useCallback(
    (actorId: string | null, pointIndex: number | null, controlType: CurveControlType = "anchor"): void => {
      window.dispatchEvent(
        new CustomEvent(CURVE_VERTEX_SELECT_EVENT, {
          detail: {
            actorId,
            pointIndex,
            controlType
          }
        })
      );
    },
    []
  );

  useEffect(() => {
    const onCurveVertexSelect = (event: Event) => {
      const custom = event as CustomEvent<{ actorId?: string | null; pointIndex?: number | null; controlType?: string }>;
      const actorId = custom.detail?.actorId ?? null;
      const pointIndex = custom.detail?.pointIndex;
      if (!actorId || pointIndex === null || pointIndex === undefined || pointIndex < 0) {
        setSelectedCurveVertex(null);
        setSelectedCurveControl("anchor");
        return;
      }
      const controlType = custom.detail?.controlType;
      if (controlType === "anchor" || controlType === "handleIn" || controlType === "handleOut") {
        setSelectedCurveControl(controlType);
      } else {
        setSelectedCurveControl("anchor");
      }
      setSelectedCurveVertex({ actorId, pointIndex });
    };
    window.addEventListener(CURVE_VERTEX_SELECT_EVENT, onCurveVertexSelect as EventListener);
    return () => {
      window.removeEventListener(CURVE_VERTEX_SELECT_EVENT, onCurveVertexSelect as EventListener);
    };
  }, []);

  const singleSelection = actorSelection.length === 1 ? actorSelection[0] : null;
  useEffect(() => {
    if (!singleSelection || singleSelection.actorType !== "curve") {
      setSelectedCurveVertex(null);
      setSelectedCurveControl("anchor");
      return;
    }
    if (selectedCurveVertex?.actorId !== singleSelection.id) {
      setSelectedCurveVertex(null);
      setSelectedCurveControl("anchor");
    }
  }, [selectedCurveVertex?.actorId, singleSelection]);

  useEffect(() => {
    if (!singleSelection || singleSelection.actorType !== "curve" || !selectedCurveVertex) {
      return;
    }
    if (selectedCurveVertex.actorId !== singleSelection.id) {
      return;
    }
    const pointCount = curveDataWithOverrides(singleSelection).points.length;
    if (pointCount <= 0) {
      setSelectedCurveVertex(null);
      setSelectedCurveControl("anchor");
      return;
    }
    if (selectedCurveVertex.pointIndex >= pointCount) {
      const clampedPointIndex = pointCount - 1;
      setSelectedCurveVertex({ actorId: singleSelection.id, pointIndex: clampedPointIndex });
      publishCurveVertexSelect(singleSelection.id, clampedPointIndex, "anchor");
    }
  }, [publishCurveVertexSelect, selectedCurveVertex, singleSelection]);

  useEffect(() => {
    if (!singleSelection || singleSelection.actorType !== "camera-path") {
      setCameraPathPreviewPlaying(false);
      setCameraPathPreviewTimeSeconds(0);
      setSelectedCameraPathKeyframeId(null);
      cameraPathPlayStartRef.current = null;
      if (cameraPathPlayRafRef.current !== null) {
        window.cancelAnimationFrame(cameraPathPlayRafRef.current);
        cameraPathPlayRafRef.current = null;
      }
      return;
    }
    setCameraPathPreviewPlaying(false);
    setCameraPathPreviewTimeSeconds((current) => Math.max(0, current));
    setSelectedCameraPathKeyframeId((current) => current);
    cameraPathPlayStartRef.current = null;
    if (cameraPathPlayRafRef.current !== null) {
      window.cancelAnimationFrame(cameraPathPlayRafRef.current);
      cameraPathPlayRafRef.current = null;
    }
  }, [singleSelection?.actorType, singleSelection?.id]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    inspectorBackHistoryRef.current = [];
    inspectorForwardHistoryRef.current = [];
    inspectorHistorySuppressRef.current = false;
    previousInspectorViewRef.current = { kind: "actor-root" };
    setInspectorView({ kind: "actor-root" });
  }, [selection.map((s) => `${s.kind}:${s.id}`).join(",")]);

  useEffect(() => {
    const previousView = previousInspectorViewRef.current;
    if (inspectorViewsEqual(previousView, inspectorView)) {
      return;
    }
    if (inspectorHistorySuppressRef.current) {
      inspectorHistorySuppressRef.current = false;
      previousInspectorViewRef.current = cloneInspectorView(inspectorView);
      return;
    }
    const previousClone = cloneInspectorView(previousView);
    const lastBackView = inspectorBackHistoryRef.current.at(-1);
    if (!lastBackView || !inspectorViewsEqual(lastBackView, previousClone)) {
      inspectorBackHistoryRef.current.push(previousClone);
    }
    inspectorForwardHistoryRef.current = [];
    previousInspectorViewRef.current = cloneInspectorView(inspectorView);
  }, [inspectorView]);

  const updateSelectedActorParams = (key: string, nextValue: BindingValue): void => {
    for (const actor of actorSelection) {
      kernel.store.getState().actions.updateActorParams(actor.id, {
        [key]: nextValue
      });
    }
    scheduleAutosave();
  };
  const updateSelectedComponentParams = (key: string, nextValue: BindingValue): void => {
    for (const component of componentSelection) {
      kernel.store.getState().actions.updateComponentParams(component.id, {
        [key]: nextValue
      });
    }
    scheduleAutosave();
  };

  const reloadSelectedActorFileParam = (key: string): void => {
    const reloadKey = `${key}ReloadToken`;
    let updatedCount = 0;
    for (const actor of actorSelection) {
      const value = actor.params[key];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      updatedCount += 1;
      kernel.store.getState().actions.updateActorParams(actor.id, {
        [reloadKey]: Date.now() + updatedCount
      });
    }
    if (updatedCount > 0) {
      scheduleAutosave();
      kernel.store.getState().actions.setStatus(`Reload requested for ${updatedCount} file asset${updatedCount === 1 ? "" : "s"}.`);
    }
  };

  const updateSelectedActorEnabled = (nextEnabled: boolean): void => {
    for (const actor of actorSelection) {
      kernel.store.getState().actions.setNodeEnabled({ kind: "actor", id: actor.id }, nextEnabled);
    }
    scheduleAutosave();
  };

  const updateSelectedActorVisibility = (nextMode: ActorVisibilityMode): void => {
    for (const actor of actorSelection) {
      kernel.store.getState().actions.setActorVisibilityMode(actor.id, nextMode);
    }
    scheduleAutosave();
  };

  const updateSelectedActorTransformAxis = (
    key: "position" | "rotation" | "scale",
    axisIndex: 0 | 1 | 2,
    nextValue: number
  ): void => {
    for (const actor of actorSelection) {
      const current = actor.transform[key];
      const next: [number, number, number] = [current[0], current[1], current[2]];
      next[axisIndex] = nextValue;
      kernel.store.getState().actions.setActorTransform(actor.id, key, next);
    }
    scheduleAutosave();
  };

  const resetSelectedActorTransform = (key: "position" | "rotation" | "scale"): void => {
    const nextValue: [number, number, number] = key === "scale" ? [1, 1, 1] : [0, 0, 0];
    for (const actor of actorSelection) {
      kernel.store.getState().actions.setActorTransform(actor.id, key, nextValue);
    }
    scheduleAutosave();
  };

  const showSceneInspector = actorSelection.length === 0 && componentSelection.length === 0;
  const showComponentSelectionInspector = actorSelection.length === 0 && componentSelection.length > 0;

  const descriptorForSingleSelection = singleSelection ? resolveActorDescriptor(singleSelection, actorDescriptors) : undefined;
  const runtimeStatus = singleSelection ? actorStatusByActorId[singleSelection.id] : undefined;
  const statusEntries = singleSelection
    ? (descriptorForSingleSelection?.status?.build({
        actor: singleSelection,
        state: appState,
        runtimeStatus
      }) ?? getDefaultStatusEntries(singleSelection, runtimeStatus))
    : [];
  const visibleStatusEntries = statusEntries.filter(
    (entry) => entry.value !== null && entry.value !== undefined && entry.value !== ""
  );
  const statusRows: StatsRow[] = visibleStatusEntries.map((entry) => ({
    label: entry.label,
    value: formatStatusValue(entry.value),
    tone: entry.tone === "error" ? "error" : entry.tone === "warning" ? "warning" : "default"
  }));
  const statusGroups = singleSelection ? buildStatusGroups(statusRows) : [];
  const enabledValues = actorSelection.map((actor) => actor.enabled);
  const enabledMixed = enabledValues.some((value) => value !== enabledValues[0]);
  const enabledValue = enabledValues[0] ?? true;
  const visibilityValues = actorSelection.map((actor) => actor.visibilityMode ?? "visible");
  const visibilityMixed = visibilityValues.some((value) => value !== visibilityValues[0]);
  const visibilityValue = visibilityValues[0] ?? "visible";

  const positionValuesByAxis: [number[], number[], number[]] = [
    actorSelection.map((actor) => actor.transform.position[0]),
    actorSelection.map((actor) => actor.transform.position[1]),
    actorSelection.map((actor) => actor.transform.position[2])
  ];
  const rotationValuesByAxis: [number[], number[], number[]] = [
    actorSelection.map((actor) => actor.transform.rotation[0] * RAD_TO_DEG),
    actorSelection.map((actor) => actor.transform.rotation[1] * RAD_TO_DEG),
    actorSelection.map((actor) => actor.transform.rotation[2] * RAD_TO_DEG)
  ];
  const scaleValuesByAxis: [number[], number[], number[]] = [
    actorSelection.map((actor) => actor.transform.scale[0]),
    actorSelection.map((actor) => actor.transform.scale[1]),
    actorSelection.map((actor) => actor.transform.scale[2])
  ];
  const canResetEnabled = !allActorsMatch(actorSelection, (actor) => actor.enabled === true);
  const canResetVisibility = !allActorsMatch(actorSelection, (actor) => (actor.visibilityMode ?? "visible") === "visible");
  const canResetTranslation = !allActorsMatch(
    actorSelection,
    (actor) =>
      Math.abs(actor.transform.position[0]) <= 1e-9 &&
      Math.abs(actor.transform.position[1]) <= 1e-9 &&
      Math.abs(actor.transform.position[2]) <= 1e-9
  );
  const canResetRotation = !allActorsMatch(
    actorSelection,
    (actor) =>
      Math.abs(actor.transform.rotation[0]) <= 1e-9 &&
      Math.abs(actor.transform.rotation[1]) <= 1e-9 &&
      Math.abs(actor.transform.rotation[2]) <= 1e-9
  );
  const canResetScale = !allActorsMatch(
    actorSelection,
    (actor) =>
      Math.abs(actor.transform.scale[0] - 1) <= 1e-9 &&
      Math.abs(actor.transform.scale[1] - 1) <= 1e-9 &&
      Math.abs(actor.transform.scale[2] - 1) <= 1e-9
  );
  const cameraPathRefs =
    singleSelection && singleSelection.actorType === "camera-path"
      ? resolveCameraPathRefs(singleSelection, actors)
      : null;
  const cameraPathValidity =
    singleSelection && singleSelection.actorType === "camera-path"
      ? getCameraPathValidity(singleSelection, actors)
      : null;
  const cameraPathKeyframeCount =
    singleSelection && singleSelection.actorType === "camera-path"
      ? getCameraPathKeyframeCount(singleSelection, actors)
      : 0;
  const cameraPathKeyframes =
    singleSelection && singleSelection.actorType === "camera-path"
      ? getCameraPathKeyframes(singleSelection, actors)
      : [];
  const cameraPathDurationSeconds =
    singleSelection && singleSelection.actorType === "camera-path"
      ? getCameraPathDurationSeconds(singleSelection, actors)
      : 0;
  const selectedCameraPathKeyframeIndex = cameraPathKeyframes.findIndex((entry) => entry.id === selectedCameraPathKeyframeId);
  const selectedCameraPathKeyframe =
    selectedCameraPathKeyframeIndex >= 0 ? cameraPathKeyframes[selectedCameraPathKeyframeIndex] : null;
  const cameraPathTimelineVisibleDurationSeconds = Math.max(
    1,
    cameraPathDurationSeconds + 1,
    cameraPathDurationSeconds * 1.25
  );

  const applyCameraPathPreviewPose = useCallback(
    (actor: ActorNode, timeSeconds: number) => {
      const pose = sampleCameraPathPoseAtTime(actor, kernel.store.getState().state.actors, timeSeconds);
      if (!pose) {
        return false;
      }
      kernel.store.getState().actions.setCameraState(
        {
          position: pose.position,
          target: pose.target
        },
        false
      );
      return true;
    },
    [kernel]
  );

  useEffect(() => {
    if (!singleSelection || singleSelection.actorType !== "camera-path") {
      return;
    }
    const duration = getCameraPathDurationSeconds(singleSelection, actors);
    setCameraPathPreviewTimeSeconds((current) => Math.max(0, Math.min(duration, current)));
    if (cameraPathKeyframes.length <= 0) {
      setSelectedCameraPathKeyframeId(null);
      return;
    }
    if (!selectedCameraPathKeyframeId || !cameraPathKeyframes.some((entry) => entry.id === selectedCameraPathKeyframeId)) {
      setSelectedCameraPathKeyframeId(cameraPathKeyframes[0]?.id ?? null);
    }
  }, [actors, cameraPathKeyframes, selectedCameraPathKeyframeId, singleSelection]);

  useEffect(() => {
    if (!singleSelection || singleSelection.actorType !== "camera-path" || !cameraPathPreviewPlaying) {
      if (cameraPathPlayRafRef.current !== null) {
        window.cancelAnimationFrame(cameraPathPlayRafRef.current);
        cameraPathPlayRafRef.current = null;
      }
      return;
    }

    const durationSeconds = getCameraPathDurationSeconds(singleSelection, actors);
    const playStart =
      cameraPathPlayStartRef.current ?? {
        startedAtMs: performance.now(),
        startedTimeSeconds: cameraPathPreviewTimeSeconds
      };
    cameraPathPlayStartRef.current = playStart;

    const tick = (nowMs: number) => {
      if (!cameraPathPlayStartRef.current) {
        cameraPathPlayRafRef.current = null;
        return;
      }
      const elapsed = nowMs - cameraPathPlayStartRef.current.startedAtMs;
      const nextTimeSeconds = cameraPathPlayStartRef.current.startedTimeSeconds + elapsed / 1000;
      const clamped = Math.max(0, Math.min(durationSeconds, nextTimeSeconds));
      setCameraPathPreviewTimeSeconds(clamped);
      applyCameraPathPreviewPose(singleSelection, clamped);
      if (clamped >= durationSeconds) {
        setCameraPathPreviewPlaying(false);
        cameraPathPlayStartRef.current = null;
        cameraPathPlayRafRef.current = null;
        return;
      }
      cameraPathPlayRafRef.current = window.requestAnimationFrame(tick);
    };

    cameraPathPlayRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (cameraPathPlayRafRef.current !== null) {
        window.cancelAnimationFrame(cameraPathPlayRafRef.current);
        cameraPathPlayRafRef.current = null;
      }
    };
  }, [applyCameraPathPreviewPose, cameraPathPreviewPlaying, singleSelection]);

  const addCurveVertex = (): void => {
    if (!singleSelection || singleSelection.actorType !== "curve" || readOnly) {
      return;
    }
    const nextCurve = appendCurvePoint(curveDataWithOverrides(singleSelection));
    kernel.store.getState().actions.updateActorParams(singleSelection.id, {
      curveData: nextCurve
    });
    scheduleAutosave();
    kernel.store.getState().actions.setStatus("Curve vertex added.");
  };

  const updateSingleCurve = (mutator: (actor: ActorNode) => ParameterValue): void => {
    if (!singleSelection || singleSelection.actorType !== "curve" || readOnly) {
      return;
    }
    kernel.store.getState().actions.updateActorParams(singleSelection.id, {
      curveData: mutator(singleSelection)
    });
    scheduleAutosave();
  };

  const addCameraPathKeyframe = (): void => {
    if (!singleSelection || singleSelection.actorType !== "camera-path" || readOnly || !cameraPathRefs) {
      return;
    }
    if (!cameraPathRefs.positionCurveActor || !cameraPathRefs.targetCurveActor) {
      kernel.store.getState().actions.setStatus("Camera path keyframe add is unavailable until both managed curves exist.");
      return;
    }
    const camera = kernel.store.getState().state.camera;
    const actions = kernel.store.getState().actions;
    actions.pushHistory("Add camera path keyframe");
    actions.updateActorParamsNoHistory(cameraPathRefs.positionCurveActor.id, {
      curveData: appendCameraPathCurvePoint(cameraPathRefs.positionCurveActor, camera.position)
    });
    actions.updateActorParamsNoHistory(cameraPathRefs.targetCurveActor.id, {
      curveData: appendCameraPathCurvePoint(cameraPathRefs.targetCurveActor, camera.target)
    });
    const nextKeyframes = [...cameraPathKeyframes];
    const nextKeyframe = createCameraPathKeyframe(
      nextKeyframes.length <= 0 ? 0 : (nextKeyframes[nextKeyframes.length - 1]?.timeSeconds ?? 0) + 1
    );
    nextKeyframes.push(nextKeyframe);
    actions.updateActorParamsNoHistory(singleSelection.id, {
      keyframes: nextKeyframes
    });
    setSelectedCameraPathKeyframeId(nextKeyframe.id);
    setCameraPathPreviewTimeSeconds(nextKeyframe.timeSeconds);
    scheduleAutosave();
    applyCameraPathPreviewPose(singleSelection, nextKeyframe.timeSeconds);
    kernel.store.getState().actions.setStatus("Camera path keyframe added from current camera.");
  };

  const applyCameraPathKeyframeIndex = useCallback(
    (actor: ActorNode, keyframeIndex: number) => {
      const stateActors = kernel.store.getState().state.actors;
      const count = getCameraPathKeyframeCount(actor, stateActors);
      const clampedIndex = count <= 0 ? 0 : Math.max(0, Math.min(count - 1, keyframeIndex));
      const nextTimeSeconds = getCameraPathTimeAtKeyframeIndex(actor, stateActors, clampedIndex);
      const nextKeyframes = getCameraPathKeyframes(actor, stateActors);
      setSelectedCameraPathKeyframeId(nextKeyframes[clampedIndex]?.id ?? null);
      setCameraPathPreviewTimeSeconds(nextTimeSeconds);
      cameraPathPlayStartRef.current = null;
      applyCameraPathPreviewPose(actor, nextTimeSeconds);
    },
    [applyCameraPathPreviewPose, kernel]
  );

  const updateCameraPathKeyframeTime = useCallback(
    (actor: ActorNode, keyframeId: string, nextTimeSeconds: number) => {
      const keyframes = getCameraPathKeyframes(actor, kernel.store.getState().state.actors);
      const keyframeIndex = keyframes.findIndex((entry) => entry.id === keyframeId);
      if (keyframeIndex < 0) {
        return;
      }
      const clampedTime = clampCameraPathKeyframeTime(keyframes, keyframeIndex, nextTimeSeconds);
      const nextKeyframes = keyframes.map((entry, index) =>
        index === keyframeIndex ? { ...entry, timeSeconds: clampedTime } : entry
      );
      kernel.store.getState().actions.updateActorParamsNoHistory(actor.id, {
        keyframes: nextKeyframes
      });
      setCameraPathPreviewTimeSeconds(clampedTime);
      applyCameraPathPreviewPose(actor, clampedTime);
    },
    [applyCameraPathPreviewPose, kernel]
  );

  const commitCameraPathKeyframeTime = useCallback(
    (actor: ActorNode, keyframeId: string, nextTimeSeconds: number) => {
      kernel.store.getState().actions.pushHistory("Retiming camera path keyframe");
      updateCameraPathKeyframeTime(actor, keyframeId, nextTimeSeconds);
      scheduleAutosave();
    },
    [kernel, scheduleAutosave, updateCameraPathKeyframeTime]
  );

  const updateSelectedCameraPathKeyframe = useCallback(() => {
    if (!singleSelection || singleSelection.actorType !== "camera-path" || readOnly || !selectedCameraPathKeyframe) {
      return;
    }
    if (!cameraPathRefs?.positionCurveActor || !cameraPathRefs.targetCurveActor) {
      return;
    }
    const camera = kernel.store.getState().state.camera;
    const actions = kernel.store.getState().actions;
    actions.pushHistory("Update camera path keyframe");
    const keyframeIndex = cameraPathKeyframes.findIndex((entry) => entry.id === selectedCameraPathKeyframe.id);
    if (keyframeIndex < 0) {
      return;
    }
    const nextPositionCurve = setCurveAnchorPosition(
      curveDataWithOverrides(cameraPathRefs.positionCurveActor),
      keyframeIndex,
      camera.position
    );
    actions.updateActorParamsNoHistory(cameraPathRefs.positionCurveActor.id, {
      curveData: nextPositionCurve
    });
    if (cameraPathRefs.targetMode === "curve") {
      const nextTargetCurve = setCurveAnchorPosition(
        curveDataWithOverrides(cameraPathRefs.targetCurveActor),
        keyframeIndex,
        camera.target
      );
      actions.updateActorParamsNoHistory(cameraPathRefs.targetCurveActor.id, {
        curveData: nextTargetCurve
      });
    }
    applyCameraPathPreviewPose(singleSelection, selectedCameraPathKeyframe.timeSeconds);
    scheduleAutosave();
    actions.setStatus("Camera path keyframe updated from current camera.");
  }, [
    applyCameraPathPreviewPose,
    cameraPathKeyframes,
    cameraPathRefs,
    kernel,
    readOnly,
    scheduleAutosave,
    selectedCameraPathKeyframe,
    singleSelection
  ]);

  const deleteSelectedCameraPathKeyframe = useCallback(() => {
    if (!singleSelection || singleSelection.actorType !== "camera-path" || readOnly || !selectedCameraPathKeyframe) {
      return;
    }
    if (!cameraPathRefs?.positionCurveActor || !cameraPathRefs.targetCurveActor) {
      return;
    }
    const keyframeIndex = cameraPathKeyframes.findIndex((entry) => entry.id === selectedCameraPathKeyframe.id);
    if (keyframeIndex < 0) {
      return;
    }
    const actions = kernel.store.getState().actions;
    actions.pushHistory("Delete camera path keyframe");
    actions.updateActorParamsNoHistory(cameraPathRefs.positionCurveActor.id, {
      curveData: removeCurvePoint(curveDataWithOverrides(cameraPathRefs.positionCurveActor), keyframeIndex)
    });
    actions.updateActorParamsNoHistory(cameraPathRefs.targetCurveActor.id, {
      curveData: removeCurvePoint(curveDataWithOverrides(cameraPathRefs.targetCurveActor), keyframeIndex)
    });
    const nextKeyframes = cameraPathKeyframes.filter((entry) => entry.id !== selectedCameraPathKeyframe.id);
    actions.updateActorParamsNoHistory(singleSelection.id, {
      keyframes: nextKeyframes
    });
    const nextSelected =
      nextKeyframes[Math.max(0, Math.min(keyframeIndex, nextKeyframes.length - 1))] ?? null;
    setSelectedCameraPathKeyframeId(nextSelected?.id ?? null);
    setCameraPathPreviewTimeSeconds(nextSelected?.timeSeconds ?? 0);
    applyCameraPathPreviewPose(singleSelection, nextSelected?.timeSeconds ?? 0);
    scheduleAutosave();
    actions.setStatus("Camera path keyframe deleted.");
  }, [
    applyCameraPathPreviewPose,
    cameraPathKeyframes,
    cameraPathRefs,
    kernel,
    readOnly,
    scheduleAutosave,
    selectedCameraPathKeyframe,
    singleSelection
  ]);

  const resolveCameraPathTimelineTime = useCallback(
    (event: { clientX: number }) => {
      const rail = cameraPathTimelineRailRef.current;
      if (!rail) {
        return 0;
      }
      const rect = rail.getBoundingClientRect();
      const fraction = rect.width <= 1 ? 0 : Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      return fraction * cameraPathTimelineVisibleDurationSeconds;
    },
    [cameraPathTimelineVisibleDurationSeconds]
  );

  useEffect(() => {
    const onPointerMove = (event: MouseEvent) => {
      if (!singleSelection || singleSelection.actorType !== "camera-path") {
        return;
      }
      const drag = cameraPathTimelineDragRef.current;
      if (!drag) {
        return;
      }
      if (drag.mode === "playhead") {
        const nextTimeSeconds = Math.max(0, Math.min(cameraPathDurationSeconds, resolveCameraPathTimelineTime(event)));
        setCameraPathPreviewTimeSeconds(nextTimeSeconds);
        applyCameraPathPreviewPose(singleSelection, nextTimeSeconds);
        return;
      }
      if (drag.mode === "keyframe" && drag.keyframeId) {
        updateCameraPathKeyframeTime(singleSelection, drag.keyframeId, resolveCameraPathTimelineTime(event));
      }
    };

    const onPointerUp = (event: MouseEvent) => {
      if (!singleSelection || singleSelection.actorType !== "camera-path") {
        cameraPathTimelineDragRef.current = null;
        return;
      }
      const drag = cameraPathTimelineDragRef.current;
      cameraPathTimelineDragRef.current = null;
      if (!drag || drag.mode !== "keyframe" || !drag.keyframeId) {
        return;
      }
      updateCameraPathKeyframeTime(singleSelection, drag.keyframeId, resolveCameraPathTimelineTime(event));
      scheduleAutosave();
    };

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [
    applyCameraPathPreviewPose,
    cameraPathDurationSeconds,
    resolveCameraPathTimelineTime,
    scheduleAutosave,
    singleSelection,
    updateCameraPathKeyframeTime
  ]);

  const handleBack = useCallback(() => {
    const previousView = inspectorBackHistoryRef.current.pop();
    if (!previousView) {
      return false;
    }
    const currentView = cloneInspectorView(inspectorView);
    const lastForwardView = inspectorForwardHistoryRef.current.at(-1);
    if (!lastForwardView || !inspectorViewsEqual(lastForwardView, currentView)) {
      inspectorForwardHistoryRef.current.push(currentView);
    }
    inspectorHistorySuppressRef.current = true;
    setInspectorView(previousView);
    return true;
  }, [inspectorView]);

  const handleForward = useCallback(() => {
    const nextView = inspectorForwardHistoryRef.current.pop();
    if (!nextView) {
      return false;
    }
    const currentView = cloneInspectorView(inspectorView);
    const lastBackView = inspectorBackHistoryRef.current.at(-1);
    if (!lastBackView || !inspectorViewsEqual(lastBackView, currentView)) {
      inspectorBackHistoryRef.current.push(currentView);
    }
    inspectorHistorySuppressRef.current = true;
    setInspectorView(nextView);
    return true;
  }, [inspectorView]);

  useEffect(() => {
    const onBackRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ handled?: boolean }>;
      if (customEvent.detail?.handled) {
        return;
      }
      if (selection.length === 0 || inspectorView.kind === "actor-root") {
        return;
      }
      if (handleBack() && customEvent.detail) {
        customEvent.detail.handled = true;
      }
    };
    window.addEventListener(NAVIGATE_BACK_REQUEST_EVENT, onBackRequest);
    return () => {
      window.removeEventListener(NAVIGATE_BACK_REQUEST_EVENT, onBackRequest);
    };
  }, [handleBack, inspectorView.kind, selection.length]);

  useEffect(() => {
    const onForwardRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ handled?: boolean }>;
      if (customEvent.detail?.handled) {
        return;
      }
      if (selection.length === 0) {
        return;
      }
      if (handleForward() && customEvent.detail) {
        customEvent.detail.handled = true;
      }
    };
    window.addEventListener(NAVIGATE_FORWARD_REQUEST_EVENT, onForwardRequest);
    return () => {
      window.removeEventListener(NAVIGATE_FORWARD_REQUEST_EVENT, onForwardRequest);
    };
  }, [handleForward, selection.length]);

  if (showSceneInspector) {
    return (
      <SceneInspectorView
        appState={appState}
        readOnly={readOnly}
        sceneBackgroundInput={sceneBackgroundInput}
        setSceneBackgroundInput={setSceneBackgroundInput}
        kernel={kernel}
      />
    );
  }

  if (showComponentSelectionInspector) {
    return (
      <ComponentSelectionInspectorView
        componentSelection={componentSelection}
        componentDefinitions={componentDefinitions}
        readOnly={readOnly}
        updateSelectedComponentParams={updateSelectedComponentParams}
      />
    );
  }

  const cameraPathCurrentKeyframeIndex =
    singleSelection && singleSelection.actorType === "camera-path"
      ? getCameraPathKeyframeIndexAtTime(singleSelection, actors, cameraPathPreviewTimeSeconds)
      : 0;

  return (
    <div className="inspector-pane-root custom-inspector">
      <section className="inspector-common-card">
        <header>
          <h4>Actor</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Enabled</span>
            <div className="inspector-common-control-wrap">
              <ToggleField
                label=""
                checked={enabledValue}
                mixed={enabledMixed}
                disabled={readOnly}
                embedded
                onChange={(next) => updateSelectedActorEnabled(next)}
              />
              <button
                type="button"
                className={`widget-reset-button${canResetEnabled ? "" : " is-hidden"}`}
                title="Reset Enabled"
                disabled={readOnly || !canResetEnabled}
                onClick={() => updateSelectedActorEnabled(true)}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Visibility</span>
            <div className="inspector-common-control-wrap">
              <select
                className="widget-select"
                value={visibilityMixed ? "" : visibilityValue}
                disabled={readOnly}
                onChange={(event) => {
                  const next = event.target.value as ActorVisibilityMode;
                  if (!next) {
                    return;
                  }
                  updateSelectedActorVisibility(next);
                }}
              >
                {visibilityMixed ? <option value="">Mixed...</option> : null}
                {VISIBILITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === "visible" ? "Visible" : option === "hidden" ? "Hidden" : "Visible When Selected"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`widget-reset-button${canResetVisibility ? "" : " is-hidden"}`}
                title="Reset Visibility"
                disabled={readOnly || !canResetVisibility}
                onClick={() => updateSelectedActorVisibility("visible")}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Translate (m)</span>
            <div className="inspector-common-control-wrap">
              <div className="inspector-vector-inputs">
                {([0, 1, 2] as const).map((axisIndex) => {
                  const values = positionValuesByAxis[axisIndex];
                  return (
                    <div key={`pos-${axisIndex}`} className="inspector-vector-cell">
                      <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                      <DigitScrubInput
                        value={values[0] ?? 0}
                        mixed={isMixedNumber(values)}
                        precision={3}
                        disabled={readOnly}
                        onChange={(next) => updateSelectedActorTransformAxis("position", axisIndex, next)}
                      />
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className={`widget-reset-button${canResetTranslation ? "" : " is-hidden"}`}
                title="Reset Translation"
                disabled={readOnly || !canResetTranslation}
                onClick={() => resetSelectedActorTransform("position")}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Rotate (deg)</span>
            <div className="inspector-common-control-wrap">
              <div className="inspector-vector-inputs">
                {([0, 1, 2] as const).map((axisIndex) => {
                  const values = rotationValuesByAxis[axisIndex];
                  return (
                    <div key={`rot-${axisIndex}`} className="inspector-vector-cell">
                      <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                      <DigitScrubInput
                        value={values[0] ?? 0}
                        mixed={isMixedNumber(values)}
                        precision={2}
                        disabled={readOnly}
                        onChange={(next) => updateSelectedActorTransformAxis("rotation", axisIndex, next * DEG_TO_RAD)}
                      />
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className={`widget-reset-button${canResetRotation ? "" : " is-hidden"}`}
                title="Reset Rotation"
                disabled={readOnly || !canResetRotation}
                onClick={() => resetSelectedActorTransform("rotation")}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Scale</span>
            <div className="inspector-common-control-wrap">
              <div className="inspector-vector-inputs">
                {([0, 1, 2] as const).map((axisIndex) => {
                  const values = scaleValuesByAxis[axisIndex];
                  return (
                    <div key={`scale-${axisIndex}`} className="inspector-vector-cell">
                      <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                      <DigitScrubInput
                        value={values[0] ?? 1}
                        mixed={isMixedNumber(values)}
                        precision={3}
                        disabled={readOnly}
                        onChange={(next) => updateSelectedActorTransformAxis("scale", axisIndex, Math.max(0, next))}
                      />
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className={`widget-reset-button${canResetScale ? "" : " is-hidden"}`}
                title="Reset Scale"
                disabled={readOnly || !canResetScale}
                onClick={() => resetSelectedActorTransform("scale")}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
            </div>
          </div>
        </div>
      </section>
      {singleSelection?.actorType === "camera-path" ? (
        <section className="widget-row">
          <div className="widget-row-header">
            <span className="widget-label">Camera Path</span>
          </div>
          <div className="camera-path-panel">
            <div className="camera-path-toolbar">
              <button
                type="button"
                disabled={readOnly || !cameraPathRefs?.positionCurveActor || !cameraPathRefs.targetCurveActor}
                onClick={addCameraPathKeyframe}
              >
                Add Keyframe
              </button>
              <button
                type="button"
                disabled={!cameraPathValidity?.ok || cameraPathKeyframeCount <= 0}
                onClick={() => {
                  if (!singleSelection || singleSelection.actorType !== "camera-path") {
                    return;
                  }
                  setCameraPathPreviewPlaying(false);
                  applyCameraPathKeyframeIndex(singleSelection, cameraPathCurrentKeyframeIndex - 1);
                }}
                title="Previous keyframe"
              >
                <FontAwesomeIcon icon={faBackwardStep} />
              </button>
              <button
                type="button"
                disabled={!cameraPathValidity?.ok || cameraPathKeyframeCount <= 0}
                onClick={() => {
                  if (!singleSelection || singleSelection.actorType !== "camera-path") {
                    return;
                  }
                  if (cameraPathPreviewPlaying) {
                    setCameraPathPreviewPlaying(false);
                    cameraPathPlayStartRef.current = null;
                    return;
                  }
                  cameraPathPlayStartRef.current = {
                    startedAtMs: performance.now(),
                    startedTimeSeconds: cameraPathPreviewTimeSeconds
                  };
                  setCameraPathPreviewPlaying(true);
                }}
                title={cameraPathPreviewPlaying ? "Pause preview" : "Play preview"}
              >
                <FontAwesomeIcon icon={cameraPathPreviewPlaying ? faPause : faPlay} />
              </button>
              <button
                type="button"
                disabled={!cameraPathValidity?.ok || cameraPathKeyframeCount <= 0}
                onClick={() => {
                  if (!singleSelection || singleSelection.actorType !== "camera-path") {
                    return;
                  }
                  setCameraPathPreviewPlaying(false);
                  applyCameraPathKeyframeIndex(singleSelection, cameraPathCurrentKeyframeIndex + 1);
                }}
                title="Next keyframe"
              >
                <FontAwesomeIcon icon={faForwardStep} />
              </button>
              <button
                type="button"
                disabled={!cameraPathValidity?.ok || cameraPathKeyframeCount <= 0}
                onClick={() => {
                  if (!singleSelection || singleSelection.actorType !== "camera-path") {
                    return;
                  }
                  setCameraPathPreviewPlaying(false);
                  applyCameraPathKeyframeIndex(singleSelection, 0);
                }}
                title="Stop and reset"
              >
                <FontAwesomeIcon icon={faStop} />
              </button>
            </div>
            <div className="camera-path-summary">
              <div className="camera-path-summary-row">
                <span>Preview</span>
                <span>
                  {cameraPathKeyframeCount <= 0
                    ? "No keyframes"
                    : `Keyframe ${String(cameraPathCurrentKeyframeIndex + 1)} / ${String(cameraPathKeyframeCount)}`}
                </span>
              </div>
              <div className="camera-path-summary-row">
                <span>Playhead</span>
                <span>{cameraPathPreviewTimeSeconds.toFixed(2)}s</span>
              </div>
              <div className="camera-path-summary-row">
                <span>Position Curve</span>
                <span>{cameraPathRefs?.positionCurveActor?.name ?? "Missing"}</span>
              </div>
              {cameraPathRefs?.targetMode === "curve" ? (
                <div className="camera-path-summary-row">
                  <span>Target Curve</span>
                  <span>{cameraPathRefs.targetCurveActor?.name ?? "Missing"}</span>
                </div>
              ) : null}
              {cameraPathValidity?.message ? (
                <div className="camera-path-summary-row is-error">
                  <span>Status</span>
                  <span>{cameraPathValidity.message}</span>
                </div>
              ) : null}
              {cameraPathRefs?.targetMode === "actor" ? (
                <div className="camera-path-summary-row">
                  <span>Target Actor</span>
                  <span>{cameraPathRefs.targetActor?.name ?? "Unassigned"}</span>
                </div>
              ) : null}
              <div className="camera-path-summary-row">
                <span>Path Duration</span>
                <span>{cameraPathDurationSeconds.toFixed(2)}s</span>
              </div>
            </div>
            <div className="camera-path-keyframe-editor">
              <div className="camera-path-keyframe-header">
                <span className="widget-label">Keyframes</span>
                <span className="camera-path-keyframe-meta">
                  {cameraPathKeyframeCount <= 0 ? "Empty" : `${String(cameraPathKeyframeCount)} total`}
                </span>
              </div>
              <div
                ref={cameraPathTimelineRailRef}
                className="camera-path-timeline"
                onMouseDown={(event) => {
                  if (!singleSelection || singleSelection.actorType !== "camera-path" || !cameraPathValidity?.ok) {
                    return;
                  }
                  const nextTimeSeconds = Math.max(
                    0,
                    Math.min(cameraPathDurationSeconds, resolveCameraPathTimelineTime(event.nativeEvent))
                  );
                  setCameraPathPreviewPlaying(false);
                  cameraPathTimelineDragRef.current = { mode: "playhead" };
                  setCameraPathPreviewTimeSeconds(nextTimeSeconds);
                  applyCameraPathPreviewPose(singleSelection, nextTimeSeconds);
                }}
              >
                <div
                  className="camera-path-timeline-playhead"
                  style={{
                    left: `${String((cameraPathPreviewTimeSeconds / cameraPathTimelineVisibleDurationSeconds) * 100)}%`
                  }}
                />
                {cameraPathKeyframes.map((keyframe, keyframeIndex) => (
                  <button
                    key={keyframe.id}
                    type="button"
                    className={`camera-path-keyframe-marker${
                      selectedCameraPathKeyframeId === keyframe.id ? " is-selected" : ""
                    }${keyframeIndex === 0 ? " is-locked" : ""}`}
                    style={{
                      left: `${String((keyframe.timeSeconds / cameraPathTimelineVisibleDurationSeconds) * 100)}%`
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!singleSelection || singleSelection.actorType !== "camera-path") {
                        return;
                      }
                      setCameraPathPreviewPlaying(false);
                      setSelectedCameraPathKeyframeId(keyframe.id);
                      setCameraPathPreviewTimeSeconds(keyframe.timeSeconds);
                      applyCameraPathPreviewPose(singleSelection, keyframe.timeSeconds);
                      if (readOnly || keyframeIndex === 0) {
                        return;
                      }
                      kernel.store.getState().actions.pushHistory("Retiming camera path keyframe");
                      cameraPathTimelineDragRef.current = { mode: "keyframe", keyframeId: keyframe.id };
                    }}
                    title={`Keyframe ${String(keyframeIndex + 1)} at ${keyframe.timeSeconds.toFixed(2)}s`}
                  />
                ))}
              </div>
              {selectedCameraPathKeyframe ? (
                <div className="camera-path-keyframe-detail">
                  <div className="camera-path-keyframe-detail-row">
                    <span className="camera-path-keyframe-label">
                      Keyframe {String(selectedCameraPathKeyframeIndex + 1)}
                    </span>
                    <div className="camera-path-keyframe-actions">
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={updateSelectedCameraPathKeyframe}
                      >
                        Update Keyframe
                      </button>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={deleteSelectedCameraPathKeyframe}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="camera-path-keyframe-detail-row">
                    <span className="camera-path-keyframe-label">Time (s)</span>
                    <input
                      type="number"
                      className="widget-number-input"
                      min={selectedCameraPathKeyframeIndex <= 0 ? 0 : undefined}
                      step={0.01}
                      value={selectedCameraPathKeyframe.timeSeconds}
                      disabled={readOnly || selectedCameraPathKeyframeIndex <= 0}
                      onChange={(event) => {
                        if (!singleSelection || singleSelection.actorType !== "camera-path") {
                          return;
                        }
                        const next = Number.parseFloat(event.target.value);
                        if (!Number.isFinite(next)) {
                          return;
                        }
                        commitCameraPathKeyframeTime(singleSelection, selectedCameraPathKeyframe.id, next);
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="camera-path-keyframe-empty">No keyframe selected.</div>
              )}
            </div>
          </div>
        </section>
      ) : null}
      {singleSelection?.actorType === "curve" && getCurveTypeFromActor(singleSelection) === "spline" ? (
        <section
          className="widget-row"
          onMouseLeave={() => {
            publishCurveVertexHover(null, null);
          }}
        >
          <div className="widget-row-header">
            <span className="widget-label">Curve Editing</span>
          </div>
          <div className="widget-row-control">
            <button type="button" disabled={readOnly} onClick={addCurveVertex}>
              Add Vertex
            </button>
          </div>
          <div className="curve-vertex-list">
            {curveDataWithOverrides(singleSelection).points.map((point, pointIndex, allPoints) => (
              <div
                key={`curve-point-${pointIndex}`}
                className={`curve-vertex-row${
                  selectedCurveVertex?.actorId === singleSelection.id && selectedCurveVertex.pointIndex === pointIndex
                    ? " selected"
                    : ""
                }${point.enabled === false ? " disabled" : ""}`}
                onClick={() => {
                  publishCurveVertexSelect(singleSelection.id, pointIndex, "anchor");
                }}
                onMouseEnter={() => {
                  publishCurveVertexHover(singleSelection.id, pointIndex);
                }}
              >
                <div className="curve-vertex-controls">
                  <span className="curve-vertex-label">V{pointIndex + 1}</span>
                  <SegmentedControl
                    compact
                    value={point.mode}
                    options={[...CURVE_HANDLE_MODE_OPTIONS]}
                    disabled={readOnly}
                    onChange={(nextMode) => {
                      if (nextMode !== "mirrored" && nextMode !== "normal" && nextMode !== "auto") {
                        return;
                      }
                      updateSingleCurve((actor) => {
                        const current = curveDataWithOverrides(actor);
                        return setCurvePointMode(current, pointIndex, nextMode);
                      });
                      if (nextMode === "normal") {
                        publishCurveVertexSelect(singleSelection.id, pointIndex, "anchor");
                      }
                    }}
                  />
                  <div className="curve-vertex-mode-list">
                    <div className="curve-vertex-weight-control">
                      <button
                        type="button"
                        className={`curve-vertex-weight-label-button${
                          selectedCurveVertex?.actorId === singleSelection.id &&
                          selectedCurveVertex.pointIndex === pointIndex &&
                          selectedCurveControl === "handleIn"
                            ? " is-active"
                            : ""
                        }`}
                        disabled={readOnly}
                        onClick={(event) => {
                          event.stopPropagation();
                          publishCurveVertexSelect(singleSelection.id, pointIndex, "handleIn");
                        }}
                      >
                        In
                      </button>
                      <SegmentedControl
                        compact
                        value={point.handleInMode ?? "normal"}
                        options={[...CURVE_WEIGHT_MODE_OPTIONS]}
                        disabled={readOnly || point.mode === "mirrored" || point.mode === "auto"}
                        onChange={(nextMode) => {
                          if (nextMode !== "normal" && nextMode !== "hard") {
                            return;
                          }
                          updateSingleCurve((actor) => {
                            const current = curveDataWithOverrides(actor);
                            return setCurveHandleWeightMode(current, pointIndex, "in", nextMode);
                          });
                        }}
                      />
                    </div>
                    <div className="curve-vertex-weight-control">
                      <button
                        type="button"
                        className={`curve-vertex-weight-label-button${
                          selectedCurveVertex?.actorId === singleSelection.id &&
                          selectedCurveVertex.pointIndex === pointIndex &&
                          selectedCurveControl === "handleOut"
                            ? " is-active"
                            : ""
                        }`}
                        disabled={readOnly}
                        onClick={(event) => {
                          event.stopPropagation();
                          publishCurveVertexSelect(singleSelection.id, pointIndex, "handleOut");
                        }}
                      >
                        Out
                      </button>
                      <SegmentedControl
                        compact
                        value={point.handleOutMode ?? "normal"}
                        options={[...CURVE_WEIGHT_MODE_OPTIONS]}
                        disabled={readOnly || point.mode === "mirrored" || point.mode === "auto"}
                        onChange={(nextMode) => {
                          if (nextMode !== "normal" && nextMode !== "hard") {
                            return;
                          }
                          updateSingleCurve((actor) => {
                            const current = curveDataWithOverrides(actor);
                            return setCurveHandleWeightMode(current, pointIndex, "out", nextMode);
                          });
                        }}
                      />
                    </div>
                  </div>
                  <div className="curve-vertex-actions">
                    <button
                      type="button"
                      className="curve-vertex-action"
                      disabled={readOnly}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateSingleCurve((actor) => duplicateCurvePoint(curveDataWithOverrides(actor), pointIndex));
                        publishCurveVertexSelect(singleSelection.id, pointIndex + 1, selectedCurveControl);
                      }}
                      title="Duplicate vertex below"
                    >
                      <FontAwesomeIcon icon={faClone} />
                    </button>
                    <button
                      type="button"
                      className="curve-vertex-delete"
                      disabled={readOnly || allPoints.length <= 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateSingleCurve((actor) => removeCurvePoint(curveDataWithOverrides(actor), pointIndex));
                        if (allPoints.length > 1) {
                          const nextIndex = Math.max(0, Math.min(pointIndex, allPoints.length - 2));
                          publishCurveVertexSelect(singleSelection.id, nextIndex, "anchor");
                        } else {
                          publishCurveVertexSelect(null, null, "anchor");
                        }
                      }}
                      title={allPoints.length <= 0 ? "Curve has no vertices." : "Delete vertex"}
                    >
                      <FontAwesomeIcon icon={faTrashCan} />
                    </button>
                  </div>
                </div>
                <div className="curve-vertex-values">
                  <button
                    type="button"
                    className="curve-vertex-enabled"
                    disabled={readOnly}
                    onClick={(event) => {
                      event.stopPropagation();
                      const nextEnabled = point.enabled === false;
                      updateSingleCurve((actor) =>
                        setCurvePointEnabled(curveDataWithOverrides(actor), pointIndex, nextEnabled)
                      );
                    }}
                    title={point.enabled === false ? "Enable vertex" : "Disable vertex (skip)"}
                  >
                    <FontAwesomeIcon icon={point.enabled === false ? faToggleOff : faToggleOn} />
                    <span>{point.enabled === false ? "Disabled" : "Enabled"}</span>
                  </button>
                  <div className="curve-vertex-inputs">
                    {([0, 1, 2] as const).map((axisIndex) => (
                      <div key={`curve-point-${pointIndex}-axis-${axisIndex}`} className="curve-vertex-cell">
                        <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                        <DigitScrubInput
                          value={point.position[axisIndex]}
                          precision={3}
                          disabled={readOnly}
                          onChange={(next) => {
                            updateSingleCurve((actor) => {
                              const current = curveDataWithOverrides(actor);
                              const p = current.points[pointIndex];
                              if (!p) {
                                return current;
                              }
                              const target: [number, number, number] = [...p.position];
                              target[axisIndex] = next;
                              return setCurveAnchorPosition(current, pointIndex, target);
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {inspectorView.kind !== "actor-root" && (
        <div className="inspector-nav-header">
          <button className="inspector-nav-back" onClick={handleBack}>‹</button>
          <nav className="inspector-breadcrumb">
            <button
              className="inspector-breadcrumb-segment"
              onClick={() => setInspectorView({ kind: "actor-root" })}
            >
              {singleSelection?.name ?? ""}
            </button>
            {inspectorView.kind === "param-group" && inspectorView.fromComponentId !== null && (
              <>
                <span className="inspector-breadcrumb-sep">›</span>
                <button
                  className="inspector-breadcrumb-segment"
                  onClick={() => {
                    if (inspectorView.kind !== "param-group" || inspectorView.fromComponentId === null) return;
                    const comp = components[inspectorView.fromComponentId];
                    setInspectorView({ kind: "component", componentId: inspectorView.fromComponentId, componentLabel: comp?.name ?? "" });
                  }}
                >
                  {components[inspectorView.fromComponentId]?.name ?? ""}
                </button>
              </>
            )}
            <span className="inspector-breadcrumb-sep">›</span>
            <span className="inspector-breadcrumb-current">
              {inspectorView.kind === "component" ? inspectorView.componentLabel : inspectorView.paramLabel}
            </span>
          </nav>
        </div>
      )}
      {inspectorView.kind === "component" && (() => {
        const comp = components[inspectorView.componentId];
        if (!comp) return null;
        const compDefs = getFallbackDefinitionsFromParams(comp.params);
        if (compDefs.length === 0) {
          return <div className="inspector-empty">No editable params</div>;
        }
        return compDefs.map((definition) => {
          const current = comp.params[definition.key] ?? defaultValueForDefinition(definition);
          const updateCompParam = (key: string, value: ParameterValue) => {
            kernel.store.getState().actions.updateComponentParams(inspectorView.componentId, { [key]: value });
            scheduleAutosave();
          };
          if (definition.type === "number") {
            return (
              <NumberField
                key={definition.key}
                label={definition.label}
                value={typeof current === "number" ? current : 0}
                disabled={readOnly}
                onChange={(next) => updateCompParam(definition.key, next)}
              />
            );
          }
          if (definition.type === "boolean") {
            return (
              <ToggleField
                key={definition.key}
                label={definition.label}
                checked={Boolean(current)}
                disabled={readOnly}
                onChange={(next) => updateCompParam(definition.key, next)}
              />
            );
          }
          if (definition.type === "material-slots") {
            const slotCount = Object.keys(typeof current === "object" && current !== null && !Array.isArray(current) ? (current as object) : {}).length;
            return (
              <DrillInRow
                key={definition.key}
                label={definition.label}
                summary={`${slotCount} slots`}
                onClick={() => setInspectorView({ kind: "param-group", paramKey: definition.key, paramLabel: definition.label, fromComponentId: inspectorView.componentId })}
              />
            );
          }
          return (
            <TextField
              key={definition.key}
              label={definition.label}
              value={typeof current === "string" ? current : ""}
              disabled={readOnly}
              onChange={(next) => updateCompParam(definition.key, next)}
            />
          );
        });
      })()}
      {inspectorView.kind === "actor-root" && definitions.length === 0 ? <div className="inspector-empty">No common editable params in current selection</div> : null}
      {inspectorView.kind === "actor-root" && hasBeamShaderGroup ? (
        <DrillInRow
          label={BEAM_SHADER_GROUP_LABEL}
          summary={beamShaderGroupSummary}
          onClick={() => setInspectorView({ kind: "param-group", paramKey: BEAM_SHADER_GROUP_KEY, paramLabel: BEAM_SHADER_GROUP_LABEL, fromComponentId: null })}
        />
      ) : null}
      {definitions.map((definition) => {
        if (inspectorView.kind === "component") return null;
        if (inspectorView.kind === "param-group") {
          if (inspectorView.paramKey === BEAM_SHADER_GROUP_KEY) {
            if (!isBeamShaderDefinition(definition)) return null;
          } else if (definition.key !== inspectorView.paramKey) {
            return null;
          }
        } else if (hasBeamShaderGroup && isBeamShaderDefinition(definition)) {
          return null;
        }
        const values = actorSelection.map((actor) => bindingValueFor(definition, actor));
        const mixed = isMixedValue(values);
        const current = values[0] ?? defaultValueForDefinition(definition);
        const defaultValue = defaultValueForDefinition(definition);
        const canReset = values.some((value) => !bindingValuesEqual(value, defaultValue));

        if (definition.type === "number") {
          const currentNumber = coerceFiniteNumber(current, 0);
          const defaultNumber = coerceFiniteNumber(defaultValue, 0);
          return (
            <NumberField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={currentNumber}
              mixed={mixed}
              min={definition.min}
              max={definition.max}
              step={definition.step}
              precision={definition.precision}
              unit={definition.unit}
              dragSpeed={definition.dragSpeed}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, defaultNumber);
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "boolean") {
          return (
            <ToggleField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              checked={Boolean(current)}
              mixed={mixed}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, Boolean(defaultValue));
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "color") {
          return (
            <ColorField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : "#000000"}
              mixed={mixed}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, String(defaultValue));
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "select") {
          return (
            <SelectField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : ""}
              mixed={mixed}
              options={definition.options}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, String(defaultValue));
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "actor-ref") {
          const options = actorRefOptionsForDefinition(definition, actors, actorSelection);
          return (
            <ActorRefField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : ""}
              mixed={mixed}
              options={options}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "material-ref") {
          return (
            <MaterialRefField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={typeof current === "string" ? current : ""}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next ?? null);
              }}
            />
          );
        }

        if (definition.type === "actor-ref-list") {
          const options = actorRefOptionsForDefinition(definition, actors, actorSelection);
          return (
            <ActorRefListField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              values={Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : []}
              mixed={mixed}
              options={options}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                const resetList = Array.isArray(defaultValue)
                  ? defaultValue.filter((entry): entry is string => typeof entry === "string")
                  : [];
                updateSelectedActorParams(definition.key, resetList);
              }}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "material-slots") {
          const currentSlots = (typeof current === "object" && current !== null && !Array.isArray(current)
            ? current
            : {}) as Record<string, string>;
          if (inspectorView.kind === "actor-root") {
            return (
              <DrillInRow
                key={definition.key}
                label={definition.label}
                summary={`${Object.keys(currentSlots).length} slots`}
                onClick={() => setInspectorView({ kind: "param-group", paramKey: definition.key, paramLabel: definition.label, fromComponentId: null })}
              />
            );
          }
          // In param-group view — show full material slots editor
          // Prefer runtime-detected names; fall back to import-time keys from materialSlots param.
          // Must check .length because the runtime may set an empty array (not null/undefined).
          const runtimeSlotNames = runtimeStatus?.values.materialSlotNames as string[] | undefined;
          const slotNames = runtimeSlotNames && runtimeSlotNames.length > 0
            ? runtimeSlotNames
            : Object.keys(currentSlots);
          const localMaterials = singleSelection?.params.localMaterials as Record<string, Material> | undefined;
          return (
            <div key={definition.key} className="material-slots-field">
              <label className="widget-label">{definition.label}</label>
              {slotNames.length === 0 ? (
                <p className="panel-empty">No slots detected</p>
              ) : (
                slotNames.map((slotName) => (
                  <MaterialRefField
                    key={slotName}
                    label={slotName}
                    value={currentSlots[slotName] ?? ""}
                    extraMaterials={localMaterials}
                    onChange={(next) => {
                      const updated = { ...currentSlots, [slotName]: next };
                      updateSelectedActorParams(definition.key, updated);
                    }}
                  />
                ))
              )}
            </div>
          );
        }

        if (definition.type === "file") {
          const assetId = typeof current === "string" ? current : "";
          const asset = mixed ? undefined : assets.find((entry) => entry.id === assetId);
          return (
            <FileField
              key={definition.key}
              label={definition.label}
              description={definition.description}
              value={assetId}
              mixed={mixed}
              asset={asset}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
                if (definition.clearsParams) {
                  for (const key of definition.clearsParams) {
                    updateSelectedActorParams(key, null);
                  }
                }
              }}
              onBrowse={() => {
                void (async () => {
                  try {
                    const sourcePath = await pickFileFromDialog(definition);
                    if (!sourcePath) {
                      if (!window.electronAPI) {
                        kernel.store
                          .getState()
                          .actions.setStatus("Desktop file dialogs are only available in Electron mode.");
                      }
                      return;
                    }

                    const imported = await importFileForActorParam(kernel, {
                      projectName,
                      sourcePath,
                      definition
                    });

                    // Clear any params derived from the previous file before applying the new ones
                    if (definition.clearsParams) {
                      for (const key of definition.clearsParams) {
                        updateSelectedActorParams(key, null);
                      }
                    }
                    updateSelectedActorParams(definition.key, imported.asset.id);
                    if (imported.extraParams) {
                      for (const [key, value] of Object.entries(imported.extraParams)) {
                        updateSelectedActorParams(key, value as ParameterValue);
                      }
                    }
                    kernel.store
                      .getState()
                      .actions.setStatus(`${definition.label} imported: ${imported.asset.sourceFileName}`);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : "Unknown file import error";
                    kernel.store.getState().actions.setStatus(`Unable to import ${definition.label}: ${message}`);
                  }
                })();
              }}
              onReload={() => {
                reloadSelectedActorFileParam(definition.key);
              }}
            />
          );
        }

        return (
          <TextField
            key={definition.key}
            label={definition.label}
            description={definition.description}
            value={typeof current === "string" ? current : ""}
            mixed={mixed}
            disabled={readOnly}
            showReset={canReset}
            onReset={() => {
              updateSelectedActorParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
            }}
            onChange={(next) => {
              updateSelectedActorParams(definition.key, next);
            }}
          />
        );
      })}
      {inspectorView.kind === "actor-root" && singleSelection && singleSelection.componentIds.length > 0 && (
        <div className="inspector-component-list">
          <div className="inspector-section-label">Components</div>
          {singleSelection.componentIds.map((cid) => {
            const comp = components[cid];
            if (!comp) return null;
            return (
              <DrillInRow
                key={cid}
                label={comp.name}
                onClick={() => setInspectorView({ kind: "component", componentId: cid, componentLabel: comp.name })}
              />
            );
          })}
        </div>
      )}
      {singleSelection ? (
        <StatsBlock
          title="Status"
          className="inspector-debug-card"
          titleLevel="h4"
          emptyText="No status available."
          rows={statusRows}
          groups={statusGroups}
          onCopySuccess={(label) => {
            kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
          }}
          onCopyError={(label, message) => {
            kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
          }}
        />
      ) : null}
    </div>
  );
}

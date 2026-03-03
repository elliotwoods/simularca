import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsLeftRight,
  faCircle,
  faCircleDot,
  faClone,
  faRotateLeft,
  faToggleOff,
  faToggleOn,
  faTrashCan,
  faXmark
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type {
  ActorNode,
  ActorVisibilityMode,
  FileParameterDefinition,
  ParameterDefinition,
  ParameterValue,
  ParameterValues,
  RenderEngine
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
import { curveDataWithOverrides } from "@/features/curves/model";
import { importFileForActorParam } from "@/features/imports/fileParameterImport";
import { StatsBlock } from "@/ui/components/StatsBlock";
import { ActorRefField, ActorRefListField, DigitScrubInput, FileField, NumberField, SegmentedControl, SelectField, TextField, ToggleField } from "@/ui/widgets";

type BindingValue = ParameterValue;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const VISIBILITY_OPTIONS: ActorVisibilityMode[] = ["visible", "hidden", "selected"];
const DEFAULT_SCENE_BACKGROUND = "#070b12";
const CURVE_VERTEX_SELECT_EVENT = "simularca:curve-vertex-select";
type CurveControlType = "anchor" | "handleIn" | "handleOut";
const CURVE_HANDLE_MODE_OPTIONS = [
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

function getDefaultStatusEntries(actor: ActorNode): ActorStatusEntry[] {
  return [
    { label: "Type", value: actor.actorType },
    { label: "Enabled", value: actor.enabled },
    { label: "Children", value: actor.childActorIds.length },
    { label: "Components", value: actor.componentIds.length }
  ];
}

function formatStatusValue(value: ActorStatusEntry["value"]): string {
  if (Array.isArray(value)) {
    return `${value[0].toFixed(3)}, ${value[1].toFixed(3)}, ${value[2].toFixed(3)}`;
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
  return value;
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

function isDefinitionVisibleForActor(definition: ParameterDefinition, actor: ActorNode): boolean {
  const rules = definition.visibleWhen;
  if (!rules || rules.length === 0) {
    return true;
  }
  return rules.every((rule) => {
    const value = actor.params[rule.key];
    const effectiveValue = value === undefined && rule.key === "shape" ? "cube" : value;
    return effectiveValue === rule.equals;
  });
}

function commonDefinitionsForGroup(
  actorSelection: ActorNode[],
  descriptors: ReloadableDescriptor[]
): ParameterDefinition[] {
  const firstActor = actorSelection[0];
  if (!firstActor) {
    return [];
  }
  const firstDefinitions = getParameterDefinitions(firstActor, descriptors).filter((definition) =>
    isDefinitionVisibleForActor(definition, firstActor)
  );
  const otherDefinitionsByActor = actorSelection.slice(1).map((actor) => {
    return new Map(
      getParameterDefinitions(actor, descriptors)
        .filter((definition) => isDefinitionVisibleForActor(definition, actor))
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
): { id: string; label: string }[] {
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
      label: `${actor.name} (${actor.actorType})`
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
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
  const sessionName = appState.activeSessionName;
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
      return getParameterDefinitions(first, actorDescriptors).filter((definition) =>
        isDefinitionVisibleForActor(definition, first)
      );
    }
    return commonDefinitionsForGroup(actorSelection, actorDescriptors);
  }, [actorSelection, actorDescriptors]);
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

  useEffect(() => {
    setSceneBackgroundInput(appState.scene.backgroundColor);
  }, [appState.scene.backgroundColor]);

  useEffect(
    () => () => {
      if (autosaveTimeoutRef.current !== null) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    },
    []
  );

  const scheduleAutosave = () => {
    if (autosaveTimeoutRef.current !== null) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }
    autosaveTimeoutRef.current = window.setTimeout(() => {
      kernel.sessionService.queueAutosave();
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
    key: "position" | "rotation",
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

  const resetSelectedActorTransform = (key: "position" | "rotation"): void => {
    const nextValue: [number, number, number] = [0, 0, 0];
    for (const actor of actorSelection) {
      kernel.store.getState().actions.setActorTransform(actor.id, key, nextValue);
    }
    scheduleAutosave();
  };

  if (actorSelection.length === 0 && componentSelection.length === 0) {
    const environmentActor = Object.values(appState.actors).find((actor) => actor.actorType === "environment");
    const hasEnvironmentBackground = typeof environmentActor?.params.assetId === "string" && environmentActor.params.assetId.length > 0;
    const canResetBackground = appState.scene.backgroundColor.toLowerCase() !== DEFAULT_SCENE_BACKGROUND;
    const canResetEngine = appState.scene.renderEngine !== "webgl2";
    const canResetAntialiasing = appState.scene.antialiasing !== true;
    const sceneStatsRows = [
      { label: "FPS", value: Number.isFinite(appState.stats.fps) ? appState.stats.fps.toFixed(1) : "0.0" },
      { label: "Frame (ms)", value: Number.isFinite(appState.stats.frameMs) ? appState.stats.frameMs.toFixed(2) : "0.00" },
      { label: "Camera Mode", value: appState.camera.mode === "orthographic" ? "Orthographic" : "Perspective" },
      {
        label: "Camera Position (m)",
        value: `${appState.camera.position[0].toFixed(3)}, ${appState.camera.position[1].toFixed(3)}, ${appState.camera.position[2].toFixed(3)}`
      },
      {
        label: "Camera Target (m)",
        value: `${appState.camera.target[0].toFixed(3)}, ${appState.camera.target[1].toFixed(3)}, ${appState.camera.target[2].toFixed(3)}`
      },
      {
        label: appState.camera.mode === "orthographic" ? "Camera Zoom" : "Camera FOV",
        value:
          appState.camera.mode === "orthographic"
            ? appState.camera.zoom.toFixed(3)
            : `${appState.camera.fov.toFixed(2)} deg`
      },
      {
        label: "Camera Distance (m)",
        value: Number.isFinite(appState.stats.cameraDistance) ? appState.stats.cameraDistance.toFixed(3) : "0.000"
      },
      { label: "Controls Enabled", value: appState.stats.cameraControlsEnabled ? "Yes" : "No" },
      { label: "Zoom Enabled", value: appState.stats.cameraZoomEnabled ? "Yes" : "No" },
      { label: "Draw Calls", value: Math.max(0, Math.floor(appState.stats.drawCalls)).toLocaleString() },
      { label: "Triangles", value: Math.max(0, Math.floor(appState.stats.triangles)).toLocaleString() },
      { label: "Splat Draw Calls", value: Math.max(0, Math.floor(appState.stats.splatDrawCalls)).toLocaleString() },
      { label: "Splat Triangles", value: Math.max(0, Math.floor(appState.stats.splatTriangles)).toLocaleString() },
      { label: "Visible Splats", value: Math.max(0, Math.floor(appState.stats.splatVisibleCount)).toLocaleString() },
      { label: "Resource (MB)", value: Number.isFinite(appState.stats.resourceMb) ? appState.stats.resourceMb.toFixed(1) : "0.0" },
      { label: "Heap (MB)", value: Number.isFinite(appState.stats.heapMb) ? appState.stats.heapMb.toFixed(1) : "0.0" },
      { label: "Actor Count", value: Math.max(0, Math.floor(appState.stats.actorCount)).toLocaleString() },
      { label: "Enabled Actors", value: Math.max(0, Math.floor(appState.stats.actorCountEnabled)).toLocaleString() },
      { label: "Session Size", value: `${Math.max(0, Math.floor(appState.stats.sessionFileBytes)).toLocaleString()} B` },
      { label: "Saved Size", value: `${Math.max(0, Math.floor(appState.stats.sessionFileBytesSaved)).toLocaleString()} B` }
    ];
    return (
      <div className="inspector-pane-root custom-inspector">
        <section className="inspector-common-card">
          <header>
            <h4>Scene</h4>
          </header>
          <div className="inspector-common-grid">
            <div className="inspector-common-row">
              <span className="inspector-common-label">Name</span>
              <span className="inspector-scene-value">{appState.scene.name}</span>
            </div>
            <div className="inspector-common-row">
              <span className="inspector-common-label">Background</span>
              <div className="inspector-common-control-wrap">
                <div className="inspector-scene-color-row">
                  <input
                    type="color"
                    className="inspector-color-input"
                    value={appState.scene.backgroundColor}
                    disabled={readOnly || hasEnvironmentBackground}
                    onChange={(event) => {
                      const color = event.target.value;
                      setSceneBackgroundInput(color);
                      kernel.store.getState().actions.setSceneBackgroundColor(color);
                    }}
                  />
                  <input
                    type="text"
                    className="widget-text"
                    value={sceneBackgroundInput}
                    disabled={readOnly || hasEnvironmentBackground}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSceneBackgroundInput(next);
                      if (/^#[0-9a-fA-F]{6}$/.test(next) || /^#[0-9a-fA-F]{3}$/.test(next)) {
                        kernel.store.getState().actions.setSceneBackgroundColor(next);
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={`widget-reset-button${canResetBackground ? "" : " is-hidden"}`}
                  title="Reset Background"
                  disabled={readOnly || hasEnvironmentBackground || !canResetBackground}
                  onClick={() => {
                    setSceneBackgroundInput(DEFAULT_SCENE_BACKGROUND);
                    kernel.store.getState().actions.setSceneBackgroundColor(DEFAULT_SCENE_BACKGROUND);
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
        <section className="inspector-common-card">
          <header>
            <h4>Renderer</h4>
          </header>
          <div className="inspector-common-grid">
            <div className="inspector-common-row">
              <span className="inspector-common-label">Engine</span>
              <div className="inspector-common-control-wrap">
                <select
                  className="widget-select"
                  value={appState.scene.renderEngine}
                  disabled={readOnly}
                  onChange={(event) => {
                    const value = event.target.value === "webgpu" ? "webgpu" : "webgl2";
                    kernel.store.getState().actions.setSceneRenderSettings({ renderEngine: value });
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
                  disabled={readOnly || !canResetEngine}
                  onClick={() => {
                    kernel.store.getState().actions.setSceneRenderSettings({ renderEngine: "webgl2" });
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
                  checked={appState.scene.antialiasing}
                  disabled={readOnly}
                  embedded
                  onChange={(next) => {
                    kernel.store.getState().actions.setSceneRenderSettings({
                      antialiasing: next
                    });
                  }}
                />
                <button
                  type="button"
                  className={`widget-reset-button${canResetAntialiasing ? "" : " is-hidden"}`}
                  title="Reset Anti-Aliasing"
                  disabled={readOnly || !canResetAntialiasing}
                  onClick={() => {
                    kernel.store.getState().actions.setSceneRenderSettings({
                      antialiasing: true
                    });
                  }}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                </button>
              </div>
            </div>
          </div>
        </section>
        <StatsBlock
          title="Status"
          className="inspector-debug-card"
          titleLevel="h4"
          emptyText="No status available."
          rows={sceneStatsRows}
          onCopySuccess={(label) => {
            kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
          }}
          onCopyError={(label, message) => {
            kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
          }}
        />
      </div>
    );
  }

  if (actorSelection.length === 0 && componentSelection.length > 0) {
    return (
      <div className="inspector-pane-root custom-inspector">
        <section className="inspector-common-card">
          <header>
            <h4>Component</h4>
          </header>
          <div className="inspector-common-grid">
            <div className="inspector-common-row">
              <span className="inspector-common-label">Selection</span>
              <span className="inspector-scene-value">{componentSelection.length} component(s)</span>
            </div>
          </div>
        </section>
        {componentDefinitions.length === 0 ? <div className="inspector-empty">No common editable params in current selection</div> : null}
        {componentDefinitions.map((definition) => {
          const values = componentSelection.map((component) => {
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
                value={typeof current === "number" ? current : 0}
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
                  updateSelectedComponentParams(definition.key, defaultValue);
                }}
                onChange={(next) => {
                  updateSelectedComponentParams(definition.key, next);
                }}
              />
            );
          }

          if (definition.type === "boolean") {
            return (
              <ToggleField
                key={definition.key}
                label={definition.label}
                checked={Boolean(current)}
                mixed={mixed}
                disabled={readOnly}
                showReset={canReset}
                onReset={() => {
                  updateSelectedComponentParams(definition.key, Boolean(defaultValue));
                }}
                onChange={(next) => {
                  updateSelectedComponentParams(definition.key, next);
                }}
              />
            );
          }

          if (definition.type === "select") {
            return (
              <SelectField
                key={definition.key}
                label={definition.label}
                value={typeof current === "string" ? current : ""}
                mixed={mixed}
                options={definition.options}
                disabled={readOnly}
                showReset={canReset}
                onReset={() => {
                  updateSelectedComponentParams(definition.key, String(defaultValue));
                }}
                onChange={(next) => {
                  updateSelectedComponentParams(definition.key, next);
                }}
              />
            );
          }

          return (
            <TextField
              key={definition.key}
              label={definition.label}
              value={typeof current === "string" ? current : ""}
              mixed={mixed}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedComponentParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
              }}
              onChange={(next) => {
                updateSelectedComponentParams(definition.key, next);
              }}
            />
          );
        })}
      </div>
    );
  }

  const descriptorForSingleSelection = singleSelection ? resolveActorDescriptor(singleSelection, actorDescriptors) : undefined;
  const runtimeStatus = singleSelection ? actorStatusByActorId[singleSelection.id] : undefined;
  const statusEntries = singleSelection
    ? (descriptorForSingleSelection?.status?.build({
        actor: singleSelection,
        state: appState,
        runtimeStatus
      }) ?? getDefaultStatusEntries(singleSelection))
    : [];
  const visibleStatusEntries = statusEntries.filter(
    (entry) => entry.value !== null && entry.value !== undefined && entry.value !== ""
  );
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
        </div>
      </section>
      {singleSelection?.actorType === "curve" ? (
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
                      if (nextMode !== "mirrored" && nextMode !== "normal") {
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
                        disabled={readOnly || point.mode === "mirrored"}
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
                        disabled={readOnly || point.mode === "mirrored"}
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
                      disabled={readOnly || allPoints.length <= 2}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateSingleCurve((actor) => removeCurvePoint(curveDataWithOverrides(actor), pointIndex));
                        const nextIndex = Math.max(0, Math.min(pointIndex, allPoints.length - 2));
                        publishCurveVertexSelect(singleSelection.id, nextIndex, "anchor");
                      }}
                      title={allPoints.length <= 2 ? "A curve needs at least two vertices." : "Delete vertex"}
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
      {definitions.length === 0 ? <div className="inspector-empty">No common editable params in current selection</div> : null}
      {definitions.map((definition) => {
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

        if (definition.type === "select") {
          return (
            <SelectField
              key={definition.key}
              label={definition.label}
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

        if (definition.type === "actor-ref-list") {
          const options = actorRefOptionsForDefinition(definition, actors, actorSelection);
          return (
            <ActorRefListField
              key={definition.key}
              label={definition.label}
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

        if (definition.type === "file") {
          const assetId = typeof current === "string" ? current : "";
          const asset = mixed ? undefined : assets.find((entry) => entry.id === assetId);
          return (
            <FileField
              key={definition.key}
              label={definition.label}
              value={assetId}
              mixed={mixed}
              asset={asset}
              disabled={readOnly}
              showReset={canReset}
              onReset={() => {
                updateSelectedActorParams(definition.key, typeof defaultValue === "string" ? defaultValue : "");
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

                    const importedAsset = await importFileForActorParam(kernel, {
                      sessionName,
                      sourcePath,
                      definition
                    });

                    updateSelectedActorParams(definition.key, importedAsset.id);
                    kernel.store
                      .getState()
                      .actions.setStatus(`${definition.label} imported: ${importedAsset.sourceFileName}`);
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
      {singleSelection ? (
        <StatsBlock
          title="Status"
          className="inspector-debug-card"
          titleLevel="h4"
          emptyText="No status available."
          rows={visibleStatusEntries.map((entry) => ({
            label: entry.label,
            value: formatStatusValue(entry.value),
            tone: entry.tone === "error" ? "error" : entry.tone === "warning" ? "warning" : "default"
          }))}
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

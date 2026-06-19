import { create, type StoreApi, type UseBoundStore } from "zustand";
import { produce } from "immer";
import { createId } from "@/core/ids";
import { createInitialState } from "@/core/defaults";
import { createPluginViewInstanceId, createPluginViewTabId } from "@/features/plugins/pluginViews";
import {
  DEFAULT_CAMERA_TRANSITION_DURATION_MS,
  cancelCameraTransition as cancelRequestedCameraTransition,
  requestCameraTransition,
  type CameraTransitionRequestOptions
} from "@/features/camera/transitionController";
import type {
  ActorNode,
  ActorVisibilityMode,
  AppState,
  ConsoleCommandEntry,
  ConsoleLogEntry,
  ComponentNode,
  DimensionAxis,
  DimensionSnapHover,
  DimensionSnapSettings,
  InteractionTool,
  Landmark,
  LogLevel,
  Material,
  ParameterValues,
  PluginViewState,
  RenderEngine,
  RuntimeDebugState,
  SceneColorBufferPrecision,
  SceneFramePacingSettings,
  SceneHelpersSettings,
  ScenePostProcessingSettings,
  SceneToneMappingMode,
  SceneStats,
  SelectionEntry,
  TimeSpeedPreset,
  ViewerPermissions
} from "@/core/types";
import type { AppMode, ProjectAssetRef, ProjectIdentity } from "@/types/ipc";

export interface HistoryEntry {
  label: string;
  snapshot: AppState;
}

export interface AppActions {
  hydrate(nextState: AppState): void;
  setMode(mode: AppMode): void;
  setStatus(message: string): void;
  addLog(entry: { level: LogLevel; message: string; details?: string }): void;
  appendCommandEntry(entry: Omit<ConsoleCommandEntry, "id" | "kind" | "timestampIso"> & { source: string }): string;
  updateCommandEntry(entryId: string, patch: Partial<Omit<ConsoleCommandEntry, "id" | "kind" | "source" | "timestampIso">>): void;
  clearLogs(): void;
  setDirty(dirty: boolean): void;
  pushHistory(label: string): void;
  undo(): void;
  redo(): void;
  setActiveProject(identity: ProjectIdentity | null): void;
  setSnapshotName(name: string): void;
  setSceneBackgroundColor(color: string): void;
  setSceneRenderSettings(
      settings: Partial<{
        renderEngine: RenderEngine;
        antialiasing: boolean;
        hdrOutput: boolean;
        colorBufferPrecision: SceneColorBufferPrecision;
        framePacing: Partial<SceneFramePacingSettings>;
        tonemapping: Partial<{
          mode: SceneToneMappingMode;
          dither: boolean;
          hdrPeak: number;
        }>;
        helpers: Partial<{
          grid: Partial<SceneHelpersSettings["grid"]>;
          axes: Partial<SceneHelpersSettings["axes"]>;
        }>;
        postProcessing: Partial<{
          bloom: Partial<ScenePostProcessingSettings["bloom"]>;
          vignette: Partial<ScenePostProcessingSettings["vignette"]>;
          chromaticAberration: Partial<ScenePostProcessingSettings["chromaticAberration"]>;
          grain: Partial<ScenePostProcessingSettings["grain"]>;
          ambientOcclusion: Partial<ScenePostProcessingSettings["ambientOcclusion"]>;
        }>;
        cameraKeyboardNavigation: boolean;
        cameraNavigationSpeed: number;
        cameraFlyLookInvertYaw: boolean;
        cameraFlyLookSpeed: number;
        useEnvironmentBackground: boolean;
        environmentOverrideActorId: string | null;
        defaultIblEnabled: boolean;
      }>
  ): void;
  createActor(input: {
    actorType: ActorNode["actorType"];
    name?: string;
    parentActorId?: string | null;
    pluginType?: string;
  }): string;
  createActorNoHistory(input: {
    actorType: ActorNode["actorType"];
    name?: string;
    parentActorId?: string | null;
    pluginType?: string;
    select?: boolean;
  }): string;
  /**
   * Insert pre-built actor/component clones (e.g. from paste/duplicate) in one
   * undoable step. Each top-level root is linked into the scene according to its
   * own `parentActorId` field (already set by the caller); descendant actors are
   * linked via their cloned `childActorIds`. Top-level names are de-duplicated.
   * Returns the ids that were actually inserted, and selects them.
   */
  insertDuplicatedActors(input: {
    actors: ActorNode[];
    components: ComponentNode[];
    newTopLevelIds: string[];
  }): string[];
  createDimension(input: {
    start: Landmark;
    end: Landmark;
    axis?: DimensionAxis;
    offsetDir?: [number, number, number];
    extensionGap?: number;
  }): string;
  createAnnotation(input: { anchor: Landmark; text?: string }): string;
  deleteSelection(): void;
  renameNode(node: SelectionEntry, name: string): void;
  setActorTransform(actorId: string, key: "position" | "rotation" | "scale", value: [number, number, number]): void;
  setActorTransformNoHistory(actorId: string, key: "position" | "rotation" | "scale", value: [number, number, number]): void;
  setActorVisibilityMode(actorId: string, mode: ActorVisibilityMode): void;
  setNodeEnabled(node: SelectionEntry, enabled: boolean): void;
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  select(nodes: SelectionEntry[], additive?: boolean): void;
  clearSelection(): void;
  reorderActor(actorId: string, newParentId: string | null, index: number): void;
  updateComponentParams(componentId: string, partial: ParameterValues): void;
  updateActorParams(actorId: string, partial: ParameterValues): void;
  updateActorParamsNoHistory(actorId: string, partial: ParameterValues): void;
  setTimeRunning(running: boolean): void;
  stepTime(stepMultiplier?: number): void;
  setTimeSpeed(speed: TimeSpeedPreset): void;
  setElapsedSimSeconds(seconds: number): void;
  openPluginView(input: {
    pluginId: string;
    actorId: string;
    viewType: string;
    title: string;
    preferredTabsetId?: string | null;
  }): PluginViewState;
  closePluginView(viewId: string): void;
  focusPluginView(viewId: string): void;
  setPluginViewTabset(viewId: string, tabsetId: string | null): void;
  setHdrPreviewOpen(open: boolean): void;
  requestCameraState(camera: AppState["camera"], options?: CameraTransitionRequestOptions): void;
  cancelCameraTransition(): void;
  setCameraState(
    camera: Partial<AppState["camera"]>,
    markDirty?: boolean,
    options?: {
      rememberPerspective?: boolean;
    }
  ): void;
  setRuntimeDebugSettings(settings: Partial<RuntimeDebugState>): void;
  setStats(stats: Partial<SceneStats>): void;
  setActorStatus(actorId: string, status: AppState["actorStatusByActorId"][string] | null): void;
  setInteractionTool(tool: InteractionTool): void;
  setDimensionSnap(partial: Partial<DimensionSnapSettings>): void;
  setDimensionSnapHover(hover: DimensionSnapHover): void;
  setActorFrameTimings(timings: Record<string, number>): void;
  createMaterial(input?: Partial<Material>): string;
  createMaterialFromDef(def: Omit<Material, "id">): string;
  addAssets(assets: ProjectAssetRef[]): void;
  removeAsset(assetId: string): void;
  updateMaterial(materialId: string, partial: Partial<Omit<Material, "id">>): void;
  deleteMaterial(materialId: string): void;
}

export interface AppStore {
  state: AppState;
  historyPast: HistoryEntry[];
  historyFuture: HistoryEntry[];
  actions: AppActions;
}

export type AppStoreApi = UseBoundStore<StoreApi<AppStore>>;

function cloneState(state: AppState): AppState {
  return structuredClone(state);
}

const MAX_CONSOLE_ENTRIES = 500;

function appendConsoleLog(state: any, entry: { level: LogLevel; message: string; details?: string }): void {
  const log: ConsoleLogEntry = {
    kind: "log",
    id: createId("log"),
    level: entry.level,
    message: entry.message,
    details: entry.details,
    timestampIso: new Date().toISOString()
  };
  state.consoleEntries = [...state.consoleEntries, log].slice(-MAX_CONSOLE_ENTRIES);
}

const MAX_HISTORY_ENTRIES = 100;

function withHistory(get: () => AppStore, set: (partial: Partial<AppStore>) => void, label: string): void {
  const snapshot = cloneState(get().state);
  const past = get().historyPast;
  const nextPast = past.length >= MAX_HISTORY_ENTRIES
    ? [...past.slice(past.length - MAX_HISTORY_ENTRIES + 1), { label, snapshot }]
    : [...past, { label, snapshot }];
  set({
    historyPast: nextPast,
    historyFuture: []
  });
}

function uniqueActorName(
  actors: Record<string, ActorNode>,
  desiredRaw: string,
  excludeActorId?: string
): string {
  const desired = desiredRaw.trim() || "Actor";
  const used = new Set(
    Object.values(actors)
      .filter((actor) => actor.id !== excludeActorId)
      .map((actor) => actor.name)
  );
  if (!used.has(desired)) {
    return desired;
  }

  const match = desired.match(/^(.*?)(\d+)$/);
  const suffixBase = match?.[1] ?? "";
  const base = suffixBase.length > 0 ? suffixBase : desired;
  let suffix = match ? Number(match[2]) + 1 : 2;
  while (used.has(`${base}${String(suffix)}`)) {
    suffix += 1;
  }
  return `${base}${String(suffix)}`;
}

function removeActorRecursive(state: AppState, actorId: string): void {
  const actor = state.actors[actorId];
  if (!actor) {
    return;
  }

  for (const childId of actor.childActorIds) {
    removeActorRecursive(state, childId);
  }

  for (const componentId of actor.componentIds) {
    delete state.components[componentId];
  }

  if (actor.parentActorId) {
    const parent = state.actors[actor.parentActorId];
    if (parent) {
      parent.childActorIds = parent.childActorIds.filter((id) => id !== actorId);
    }
  } else {
    state.scene.actorIds = state.scene.actorIds.filter((id) => id !== actorId);
  }

  delete state.actors[actorId];
  delete state.actorStatusByActorId[actorId];
  for (const view of Object.values(state.pluginViews)) {
    if (view.actorId === actorId) {
      if (state.focusedPluginViewId === view.id) {
        state.focusedPluginViewId = null;
      }
      delete state.pluginViews[view.id];
    }
  }
  state.selection = state.selection.filter((entry) => entry.id !== actorId);
}

/**
 * Returns true if a mutating action is permitted under the current mode.
 *
 * In editor mode every mutation is allowed; in the published-viewer build
 * (`mode === "web-ro"`) the publisher's `viewerPermissions` flags decide
 * which individual mutations leak through. Legacy publishes have no
 * permissions object → everything stays locked.
 */
function mutationAllowed(state: AppState, permission: keyof ViewerPermissions): boolean {
  if (state.mode !== "web-ro") {
    return true;
  }
  return Boolean(state.viewerPermissions?.[permission]);
}

function insertActor(state: AppState, input: {
  id: string;
  actorType: ActorNode["actorType"];
  name?: string;
  parentActorId?: string | null;
  pluginType?: string;
  select?: boolean;
}): void {
  const { id, actorType, parentActorId = null, pluginType, select = true } = input;
  const uniqueName = uniqueActorName(state.actors, input.name ?? `${actorType} actor`);
  const newActor: ActorNode = {
    id,
    name: uniqueName,
    enabled: true,
    kind: "actor",
    actorType,
    visibilityMode: "visible",
    pluginType,
    parentActorId,
    childActorIds: [],
    componentIds: [],
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params: {}
  };

  state.actors[id] = newActor;
  if (parentActorId) {
    state.actors[parentActorId]?.childActorIds.push(id);
  } else {
    state.scene.actorIds.push(id);
  }
  if (select) {
    state.selection = [{ kind: "actor", id }];
  }
  state.stats.actorCount = Object.keys(state.actors).length;
  state.stats.actorCountEnabled = Object.values(state.actors).filter((entry) => entry.enabled).length;
  state.dirty = true;
}

const DIMENSIONS_FOLDER_NAME = "Dimensions";

/**
 * Find the shared "Dimensions" folder (an empty actor used purely to group
 * dimension/annotation actors in the scene tree), creating it at the scene root
 * if it doesn't exist yet. Operates on an Immer draft.
 */
function findOrCreateDimensionsFolder(state: AppState): string {
  const existing = Object.values(state.actors).find(
    (actor) => actor.actorType === "empty" && actor.name === DIMENSIONS_FOLDER_NAME
  );
  if (existing) {
    return existing.id;
  }
  const id = createId("actor");
  insertActor(state, { id, actorType: "empty", name: DIMENSIONS_FOLDER_NAME, select: false });
  return id;
}

export function createAppStore(mode: AppMode): AppStoreApi {
  const initial = createInitialState(mode);
  return create<AppStore>((set, get) => ({
    state: initial,
    historyPast: [],
    historyFuture: [],
    actions: {
      hydrate(nextState) {
        // viewerPermissions is written once at viewer boot from publishConfig
        // (see createViewerKernel) and is not part of the project snapshot.
        // Project hydration must not clobber it or every mutation-permission
        // gate (canToggleVisibility, canEditParameters, …) would silently
        // reset to "deny" the moment openProject runs.
        const previous = get().state;
        set({
          state: {
            ...nextState,
            viewerPermissions: nextState.viewerPermissions ?? previous.viewerPermissions
          },
          historyPast: [],
          historyFuture: []
        });
      },
      setMode(nextMode) {
        set({
          state: produce(get().state, (draft) => {
            draft.mode = nextMode;
          })
        });
      },
      setStatus(message) {
        set({
          state: produce(get().state, (draft) => {
            draft.statusMessage = message;
            appendConsoleLog(draft, {
              level: "info",
              message
            });
          })
        });
      },
      addLog(entry) {
        set({
          state: produce(get().state, (draft) => {
            appendConsoleLog(draft, entry);
          })
        });
      },
      appendCommandEntry(entry) {
        const commandId = createId("cmd");
        set({
          state: produce(get().state, (draft) => {
            draft.consoleEntries = [
              ...draft.consoleEntries,
              {
                kind: "command",
                id: commandId,
                source: entry.source,
                status: entry.status,
                summary: entry.summary,
                result: entry.result,
                error: entry.error,
                details: entry.details,
                finishedAtIso: entry.finishedAtIso,
                timestampIso: new Date().toISOString()
              } satisfies ConsoleCommandEntry
            ].slice(-MAX_CONSOLE_ENTRIES);
          })
        });
        return commandId;
      },
      updateCommandEntry(entryId, patch) {
        set({
          state: produce(get().state, (draft) => {
            const index = draft.consoleEntries.findIndex((entry) => entry.kind === "command" && entry.id === entryId);
            if (index === -1) {
              return;
            }
            const current = draft.consoleEntries[index];
            if (!current || current.kind !== "command") {
              return;
            }
            const nextEntry: ConsoleCommandEntry = {
              ...current,
              ...patch
            };
            draft.consoleEntries[index] = nextEntry;
          })
        });
      },
      clearLogs() {
        set({
          state: produce(get().state, (draft) => {
            draft.consoleEntries = [];
          })
        });
      },
      setDirty(dirty) {
        set({
          state: produce(get().state, (draft) => {
            draft.dirty = dirty;
          })
        });
      },
      pushHistory(label) {
        withHistory(get, set, label);
      },
      undo() {
        const current = get();
        const last = current.historyPast.at(-1);
        if (!last) {
          return;
        }
        const nextPast = current.historyPast.slice(0, -1);
        set({
          historyPast: nextPast,
          historyFuture: [{ label: "undo", snapshot: cloneState(current.state) }, ...current.historyFuture],
          state: cloneState(last.snapshot)
        });
      },
      redo() {
        const current = get();
        const next = current.historyFuture[0];
        if (!next) {
          return;
        }
        set({
          historyPast: [...current.historyPast, { label: "redo", snapshot: cloneState(current.state) }],
          historyFuture: current.historyFuture.slice(1),
          state: cloneState(next.snapshot)
        });
      },
      setActiveProject(identity) {
        set({
          state: produce(get().state, (draft) => {
            draft.activeProject = identity;
          })
        });
      },
      setSnapshotName(name) {
        set({
          state: produce(get().state, (draft) => {
            draft.activeSnapshotName = name;
            draft.dirty = true;
          })
        });
      },
      setSceneBackgroundColor(color) {
        withHistory(get, set, "Set scene background");
        set({
          state: produce(get().state, (draft) => {
            draft.scene.backgroundColor = color;
            draft.dirty = true;
          })
        });
      },
      setSceneRenderSettings(settings) {
        withHistory(get, set, "Set scene render settings");
        set({
          state: produce(get().state, (draft) => {
            if (settings.renderEngine) {
              draft.scene.renderEngine = settings.renderEngine;
            }
            if (typeof settings.antialiasing === "boolean") {
              draft.scene.antialiasing = settings.antialiasing;
            }
            if (typeof settings.hdrOutput === "boolean") {
              draft.scene.hdrOutput = settings.hdrOutput;
            }
            if (settings.colorBufferPrecision) {
              draft.scene.colorBufferPrecision = settings.colorBufferPrecision;
            }
            if (settings.framePacing) {
              if (settings.framePacing.mode) {
                draft.scene.framePacing.mode = settings.framePacing.mode;
              }
              if (typeof settings.framePacing.targetFps === "number" && Number.isFinite(settings.framePacing.targetFps)) {
                draft.scene.framePacing.targetFps = Math.max(1, Math.round(settings.framePacing.targetFps));
              }
            }
            if (settings.tonemapping) {
              if (settings.tonemapping.mode) {
                draft.scene.tonemapping.mode = settings.tonemapping.mode;
              }
              if (typeof settings.tonemapping.dither === "boolean") {
                draft.scene.tonemapping.dither = settings.tonemapping.dither;
              }
              if (typeof settings.tonemapping.hdrPeak === "number" && Number.isFinite(settings.tonemapping.hdrPeak)) {
                draft.scene.tonemapping.hdrPeak = Math.max(1, settings.tonemapping.hdrPeak);
              }
            }
            if (settings.postProcessing) {
              if (settings.postProcessing.bloom) {
                const bloom = settings.postProcessing.bloom;
                if (typeof bloom.enabled === "boolean") {
                  draft.scene.postProcessing.bloom.enabled = bloom.enabled;
                }
                if (typeof bloom.strength === "number" && Number.isFinite(bloom.strength)) {
                  draft.scene.postProcessing.bloom.strength = Math.max(0, bloom.strength);
                }
                if (typeof bloom.radius === "number" && Number.isFinite(bloom.radius)) {
                  draft.scene.postProcessing.bloom.radius = Math.max(0, bloom.radius);
                }
                if (typeof bloom.threshold === "number" && Number.isFinite(bloom.threshold)) {
                  draft.scene.postProcessing.bloom.threshold = Math.max(0, bloom.threshold);
                }
              }
              if (settings.postProcessing.vignette) {
                const vignette = settings.postProcessing.vignette;
                if (typeof vignette.enabled === "boolean") {
                  draft.scene.postProcessing.vignette.enabled = vignette.enabled;
                }
                if (typeof vignette.offset === "number" && Number.isFinite(vignette.offset)) {
                  draft.scene.postProcessing.vignette.offset = Math.max(0, vignette.offset);
                }
                if (typeof vignette.darkness === "number" && Number.isFinite(vignette.darkness)) {
                  draft.scene.postProcessing.vignette.darkness = Math.max(0, vignette.darkness);
                }
              }
              if (settings.postProcessing.chromaticAberration) {
                const chromaticAberration = settings.postProcessing.chromaticAberration;
                if (typeof chromaticAberration.enabled === "boolean") {
                  draft.scene.postProcessing.chromaticAberration.enabled = chromaticAberration.enabled;
                }
                if (
                  typeof chromaticAberration.offset === "number" &&
                  Number.isFinite(chromaticAberration.offset)
                ) {
                  draft.scene.postProcessing.chromaticAberration.offset = Math.max(0, chromaticAberration.offset);
                }
              }
              if (settings.postProcessing.grain) {
                const grain = settings.postProcessing.grain;
                if (typeof grain.enabled === "boolean") {
                  draft.scene.postProcessing.grain.enabled = grain.enabled;
                }
                if (typeof grain.intensity === "number" && Number.isFinite(grain.intensity)) {
                  draft.scene.postProcessing.grain.intensity = Math.max(0, grain.intensity);
                }
              }
              if (settings.postProcessing.ambientOcclusion) {
                const ao = settings.postProcessing.ambientOcclusion;
                if (typeof ao.enabled === "boolean") {
                  draft.scene.postProcessing.ambientOcclusion.enabled = ao.enabled;
                }
                if (typeof ao.radius === "number" && Number.isFinite(ao.radius)) {
                  draft.scene.postProcessing.ambientOcclusion.radius = Math.max(0, ao.radius);
                }
                if (typeof ao.thickness === "number" && Number.isFinite(ao.thickness)) {
                  draft.scene.postProcessing.ambientOcclusion.thickness = Math.max(1e-4, ao.thickness);
                }
                if (typeof ao.distanceExponent === "number" && Number.isFinite(ao.distanceExponent)) {
                  draft.scene.postProcessing.ambientOcclusion.distanceExponent = Math.max(0.1, ao.distanceExponent);
                }
                if (typeof ao.scale === "number" && Number.isFinite(ao.scale)) {
                  draft.scene.postProcessing.ambientOcclusion.scale = Math.max(0, ao.scale);
                }
                if (typeof ao.samples === "number" && Number.isFinite(ao.samples)) {
                  draft.scene.postProcessing.ambientOcclusion.samples = Math.max(4, Math.round(ao.samples));
                }
                if (typeof ao.resolutionScale === "number" && Number.isFinite(ao.resolutionScale)) {
                  draft.scene.postProcessing.ambientOcclusion.resolutionScale = Math.min(1, Math.max(0.25, ao.resolutionScale));
                }
              }
            }
            if (settings.helpers) {
              if (settings.helpers.grid) {
                const grid = settings.helpers.grid;
                if (typeof grid.visible === "boolean") {
                  draft.scene.helpers.grid.visible = grid.visible;
                }
                if (typeof grid.size === "number" && Number.isFinite(grid.size)) {
                  draft.scene.helpers.grid.size = Math.max(0.001, grid.size);
                }
                if (typeof grid.majorPitch === "number" && Number.isFinite(grid.majorPitch)) {
                  draft.scene.helpers.grid.majorPitch = Math.max(1e-3, grid.majorPitch);
                }
                if (typeof grid.minorPitch === "number" && Number.isFinite(grid.minorPitch)) {
                  draft.scene.helpers.grid.minorPitch = Math.max(1e-3, grid.minorPitch);
                }
                if (typeof grid.majorColor === "string") {
                  draft.scene.helpers.grid.majorColor = grid.majorColor;
                }
                if (typeof grid.minorColor === "string") {
                  draft.scene.helpers.grid.minorColor = grid.minorColor;
                }
                if (typeof grid.opacity === "number" && Number.isFinite(grid.opacity)) {
                  draft.scene.helpers.grid.opacity = Math.max(0, Math.min(1, grid.opacity));
                }
              }
              if (settings.helpers.axes) {
                const axes = settings.helpers.axes;
                if (typeof axes.visible === "boolean") {
                  draft.scene.helpers.axes.visible = axes.visible;
                }
                if (typeof axes.size === "number" && Number.isFinite(axes.size)) {
                  draft.scene.helpers.axes.size = Math.max(0.001, axes.size);
                }
                if (typeof axes.xColor === "string") {
                  draft.scene.helpers.axes.xColor = axes.xColor;
                }
                if (typeof axes.yColor === "string") {
                  draft.scene.helpers.axes.yColor = axes.yColor;
                }
                if (typeof axes.zColor === "string") {
                  draft.scene.helpers.axes.zColor = axes.zColor;
                }
                if (typeof axes.opacity === "number" && Number.isFinite(axes.opacity)) {
                  draft.scene.helpers.axes.opacity = Math.max(0, Math.min(1, axes.opacity));
                }
              }
            }
            if (typeof settings.cameraKeyboardNavigation === "boolean") {
              draft.scene.cameraKeyboardNavigation = settings.cameraKeyboardNavigation;
            }
            if (typeof settings.cameraNavigationSpeed === "number" && Number.isFinite(settings.cameraNavigationSpeed)) {
              draft.scene.cameraNavigationSpeed = Math.max(0, settings.cameraNavigationSpeed);
            }
            if (typeof settings.cameraFlyLookInvertYaw === "boolean") {
              draft.scene.cameraFlyLookInvertYaw = settings.cameraFlyLookInvertYaw;
            }
            if (typeof settings.cameraFlyLookSpeed === "number" && Number.isFinite(settings.cameraFlyLookSpeed)) {
              draft.scene.cameraFlyLookSpeed = Math.max(0, settings.cameraFlyLookSpeed);
            }
            if (typeof settings.useEnvironmentBackground === "boolean") {
              draft.scene.useEnvironmentBackground = settings.useEnvironmentBackground;
            }
            if ("environmentOverrideActorId" in settings) {
              const id = settings.environmentOverrideActorId;
              draft.scene.environmentOverrideActorId = typeof id === "string" && id.length > 0 ? id : null;
            }
            if (typeof settings.defaultIblEnabled === "boolean") {
              draft.scene.defaultIblEnabled = settings.defaultIblEnabled;
            }
            draft.dirty = true;
          })
        });
      },
      createActor({ actorType, name, parentActorId = null, pluginType }) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return "";
        }
        const id = createId("actor");
        withHistory(get, set, "Create actor");
        set({
          state: produce(get().state, (draft) => {
            insertActor(draft, { id, actorType, name, parentActorId, pluginType, select: true });
          })
        });
        return id;
      },
      createActorNoHistory({ actorType, name, parentActorId = null, pluginType, select = false }) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return "";
        }
        const id = createId("actor");
        set({
          state: produce(get().state, (draft) => {
            insertActor(draft, { id, actorType, name, parentActorId, pluginType, select });
          })
        });
        return id;
      },
      insertDuplicatedActors({ actors, components, newTopLevelIds }) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return [];
        }
        if (actors.length === 0) {
          return [];
        }
        withHistory(get, set, "Paste actors");
        set({
          state: produce(get().state, (draft) => {
            for (const component of components) {
              draft.components[component.id] = structuredClone(component);
            }
            for (const actor of actors) {
              draft.actors[actor.id] = structuredClone(actor);
            }
            for (const id of newTopLevelIds) {
              const actor = draft.actors[id];
              if (!actor) {
                continue;
              }
              actor.name = uniqueActorName(draft.actors, actor.name, id);
              const parent = actor.parentActorId ? draft.actors[actor.parentActorId] : null;
              if (parent) {
                parent.childActorIds.push(id);
              } else {
                actor.parentActorId = null;
                draft.scene.actorIds.push(id);
              }
            }
            draft.stats.actorCount = Object.keys(draft.actors).length;
            draft.stats.actorCountEnabled = Object.values(draft.actors).filter((entry) => entry.enabled).length;
            draft.selection = newTopLevelIds
              .filter((id) => draft.actors[id])
              .map((id) => ({ kind: "actor" as const, id }));
            draft.dirty = true;
          })
        });
        return newTopLevelIds.filter((id) => get().state.actors[id]);
      },
      createDimension({ start, end, axis = "direct", offsetDir, extensionGap }) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return "";
        }
        const id = createId("actor");
        withHistory(get, set, "Create dimension");
        set({
          state: produce(get().state, (draft) => {
            const folderId = findOrCreateDimensionsFolder(draft);
            insertActor(draft, {
              id,
              actorType: "dimension",
              name: "Dimension 1",
              parentActorId: folderId,
              select: true
            });
            const actor = draft.actors[id];
            if (actor) {
              const params: ParameterValues = { start, end, axis };
              if (offsetDir) {
                params.offsetDir = offsetDir;
              }
              if (typeof extensionGap === "number" && Number.isFinite(extensionGap)) {
                params.extensionGap = Math.max(0, extensionGap);
              }
              actor.params = params;
            }
          })
        });
        return id;
      },
      createAnnotation({ anchor, text = "Note" }) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return "";
        }
        const id = createId("actor");
        withHistory(get, set, "Create annotation");
        set({
          state: produce(get().state, (draft) => {
            const folderId = findOrCreateDimensionsFolder(draft);
            insertActor(draft, {
              id,
              actorType: "annotation",
              name: "Note 1",
              parentActorId: folderId,
              select: true
            });
            const actor = draft.actors[id];
            if (actor) {
              actor.params = { anchor, text };
            }
          })
        });
        return id;
      },
      deleteSelection() {
        if (!mutationAllowed(get().state, "canDeleteActors")) {
          return;
        }
        const target = get().state.selection;
        if (target.length === 0) {
          return;
        }

        withHistory(get, set, "Delete selection");
        set({
          state: produce(get().state, (draft) => {
            for (const entry of target) {
              if (entry.kind === "actor") {
                removeActorRecursive(draft, entry.id);
              }
              if (entry.kind === "component") {
                const component = draft.components[entry.id];
                if (!component) {
                  continue;
                }
                if (component.parentActorId) {
                  const actor = draft.actors[component.parentActorId];
                  if (actor) {
                    actor.componentIds = actor.componentIds.filter((id) => id !== entry.id);
                  }
                } else {
                  draft.scene.sceneComponentIds = draft.scene.sceneComponentIds.filter((id) => id !== entry.id);
                }
                delete draft.components[entry.id];
              }
            }
            draft.selection = [];
            draft.stats.actorCount = Object.keys(draft.actors).length;
            draft.stats.actorCountEnabled = Object.values(draft.actors).filter((entry) => entry.enabled).length;
            draft.dirty = true;
          })
        });
      },
      renameNode(node, name) {
        if (!mutationAllowed(get().state, "canEditParameters")) {
          return;
        }
        withHistory(get, set, "Rename node");
        set({
          state: produce(get().state, (draft) => {
            if (node.kind === "actor") {
              const actor = draft.actors[node.id];
              if (actor) {
                actor.name = uniqueActorName(draft.actors, name, actor.id);
              }
            }
            if (node.kind === "component") {
              const component = draft.components[node.id];
              if (component) {
                component.name = name;
              }
            }
            draft.dirty = true;
          })
        });
      },
      setActorTransform(actorId, key, value) {
        if (!mutationAllowed(get().state, "canTransformActors")) {
          return;
        }
        withHistory(get, set, "Transform actor");
        set({
          state: produce(get().state, (draft) => {
            if (!draft.actors[actorId]) {
              return;
            }
            draft.actors[actorId].transform[key] = value;
            draft.dirty = true;
          })
        });
      },
      setActorTransformNoHistory(actorId, key, value) {
        if (!mutationAllowed(get().state, "canTransformActors")) {
          return;
        }
        set({
          state: produce(get().state, (draft) => {
            if (!draft.actors[actorId]) {
              return;
            }
            draft.actors[actorId].transform[key] = value;
            draft.dirty = true;
          })
        });
      },
      setActorVisibilityMode(actorId, mode) {
        if (!mutationAllowed(get().state, "canToggleVisibility")) {
          return;
        }
        withHistory(get, set, "Set actor visibility");
        set({
          state: produce(get().state, (draft) => {
            const actor = draft.actors[actorId];
            if (!actor) {
              return;
            }
            actor.visibilityMode = mode;
            draft.dirty = true;
          })
        });
      },
      setNodeEnabled(node, enabled) {
        if (!mutationAllowed(get().state, "canToggleVisibility")) {
          return;
        }
        withHistory(get, set, "Toggle enabled");
        set({
          state: produce(get().state, (draft) => {
            if (node.kind === "actor") {
              const actor = draft.actors[node.id];
              if (actor) {
                actor.enabled = enabled;
                draft.stats.actorCountEnabled = Object.values(draft.actors).filter((entry) => entry.enabled).length;
              }
            }
            if (node.kind === "component") {
              const component = draft.components[node.id];
              if (component) {
                component.enabled = enabled;
              }
            }
            draft.dirty = true;
          })
        });
      },
      setPluginEnabled(pluginId, enabled) {
        withHistory(get, set, "Toggle plugin enabled");
        set({
          state: produce(get().state, (draft) => {
            draft.pluginsEnabled[pluginId] = enabled;
            draft.dirty = true;
          })
        });
      },
      select(nodes, additive = false) {
        set({
          state: produce(get().state, (draft) => {
            if (!additive) {
              draft.selection = nodes;
              return;
            }
            const merged = [...draft.selection, ...nodes];
            draft.selection = merged.filter(
              (entry, index, list) => list.findIndex((candidate) => candidate.kind === entry.kind && candidate.id === entry.id) === index
            );
          })
        });
      },
      clearSelection() {
        set({
          state: produce(get().state, (draft) => {
            draft.selection = [];
          })
        });
      },
      reorderActor(actorId, newParentId, index) {
        if (!mutationAllowed(get().state, "canCreateActors")) {
          return;
        }
        withHistory(get, set, "Reparent actor");
        set({
          state: produce(get().state, (draft) => {
            const actor = draft.actors[actorId];
            if (!actor) {
              return;
            }
            if (newParentId === actorId) {
              return;
            }
            if (newParentId && !draft.actors[newParentId]) {
              return;
            }
            if (newParentId) {
              // Reject cycles: parent candidate cannot be inside actor's descendant chain.
              let cursor: string | null = newParentId;
              while (cursor) {
                if (cursor === actorId) {
                  return;
                }
                cursor = draft.actors[cursor]?.parentActorId ?? null;
              }
            }

            if (actor.parentActorId) {
              const oldParent = draft.actors[actor.parentActorId];
              if (oldParent) {
                oldParent.childActorIds = oldParent.childActorIds.filter((id) => id !== actorId);
              }
            } else {
              draft.scene.actorIds = draft.scene.actorIds.filter((id) => id !== actorId);
            }

            actor.parentActorId = newParentId;
            const targetList = newParentId ? draft.actors[newParentId]?.childActorIds : draft.scene.actorIds;
            if (!targetList) {
              return;
            }
            const safeIndex = Math.max(0, Math.min(targetList.length, Math.floor(index)));
            targetList.splice(safeIndex, 0, actorId);
            draft.dirty = true;
          })
        });
      },
      updateComponentParams(componentId, partial) {
        if (!mutationAllowed(get().state, "canEditParameters")) {
          return;
        }
        withHistory(get, set, "Update component params");
        set({
          state: produce(get().state, (draft) => {
            const component = draft.components[componentId] as ComponentNode | undefined;
            if (!component) {
              return;
            }
            component.params = { ...component.params, ...partial };
            draft.dirty = true;
          })
        });
      },
      updateActorParams(actorId, partial) {
        if (!mutationAllowed(get().state, "canEditParameters")) {
          return;
        }
        withHistory(get, set, "Update actor params");
        set({
          state: produce(get().state, (draft) => {
            const actor = draft.actors[actorId];
            if (!actor) {
              return;
            }
            actor.params = { ...actor.params, ...partial };
            draft.dirty = true;
          })
        });
      },
      updateActorParamsNoHistory(actorId, partial) {
        if (!mutationAllowed(get().state, "canEditParameters")) {
          return;
        }
        set({
          state: produce(get().state, (draft) => {
            const actor = draft.actors[actorId];
            if (!actor) {
              return;
            }
            actor.params = { ...actor.params, ...partial };
            draft.dirty = true;
          })
        });
      },
      setTimeRunning(running) {
        set({
          state: produce(get().state, (draft) => {
            draft.time.running = running;
          })
        });
      },
      stepTime(stepMultiplier = 1) {
        set({
          state: produce(get().state, (draft) => {
            const delta = draft.time.fixedStepSeconds * draft.time.speed * stepMultiplier;
            draft.time.elapsedSimSeconds += delta;
          })
        });
      },
      setTimeSpeed(speed) {
        set({
          state: produce(get().state, (draft) => {
            draft.time.speed = speed;
          })
        });
      },
      setElapsedSimSeconds(seconds) {
        set({
          state: produce(get().state, (draft) => {
            draft.time.elapsedSimSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : draft.time.elapsedSimSeconds;
          })
        });
      },
      openPluginView({ pluginId, actorId, viewType, title, preferredTabsetId = null }) {
        const viewId = createPluginViewInstanceId(pluginId, actorId, viewType);
        const existing = get().state.pluginViews[viewId];
        const nextView: PluginViewState = existing
          ? {
              ...existing,
              title,
              open: true,
              preferredTabsetId: preferredTabsetId ?? existing.preferredTabsetId
            }
          : {
              id: viewId,
              pluginId,
              actorId,
              viewType,
              tabId: createPluginViewTabId(pluginId, actorId, viewType),
              title,
              open: true,
              preferredTabsetId
            };
        set({
          state: produce(get().state, (draft) => {
            draft.pluginViews[viewId] = nextView;
            draft.focusedPluginViewId = viewId;
            draft.dirty = true;
          })
        });
        return nextView;
      },
      closePluginView(viewId) {
        set({
          state: produce(get().state, (draft) => {
            const view = draft.pluginViews[viewId];
            if (!view) {
              return;
            }
            view.open = false;
            if (draft.focusedPluginViewId === viewId) {
              draft.focusedPluginViewId = null;
            }
            draft.dirty = true;
          })
        });
      },
      focusPluginView(viewId) {
        set({
          state: produce(get().state, (draft) => {
            if (!draft.pluginViews[viewId]?.open) {
              return;
            }
            draft.focusedPluginViewId = viewId;
          })
        });
      },
      setHdrPreviewOpen(open) {
        set({
          state: produce(get().state, (draft) => {
            draft.hdrPreviewOpen = open;
            // Bump the focus token on every open request so re-opening focuses the
            // existing panel even when it is already open. Ephemeral UI state — does
            // not mark the project dirty.
            if (open) {
              draft.hdrPreviewFocusToken += 1;
            }
          })
        });
      },
      setPluginViewTabset(viewId, tabsetId) {
        set({
          state: produce(get().state, (draft) => {
            const view = draft.pluginViews[viewId];
            if (!view) {
              return;
            }
            view.preferredTabsetId = tabsetId;
          })
        });
      },
      requestCameraState(camera, options) {
        const animated = options?.animated ?? false;
        const durationMs = options?.durationMs ?? DEFAULT_CAMERA_TRANSITION_DURATION_MS;
        const markDirty = options?.markDirty ?? true;
        if (
          requestCameraTransition(camera, {
            animated,
            durationMs,
            markDirty
          })
        ) {
          return;
        }
        get().actions.setCameraState(camera, markDirty);
      },
      cancelCameraTransition() {
        cancelRequestedCameraTransition();
      },
      setCameraState(camera, markDirty = true, options) {
        set({
          state: produce(get().state, (draft) => {
            draft.camera = { ...draft.camera, ...camera };
            if ((options?.rememberPerspective ?? true) && draft.camera.mode === "perspective") {
              draft.lastPerspectiveCamera = structuredClone(draft.camera);
            }
            if (markDirty) {
              draft.dirty = true;
            }
          })
        });
      },
      setRuntimeDebugSettings(settings) {
        set({
          state: produce(get().state, (draft) => {
            if (typeof settings.slowFrameDiagnosticsEnabled === "boolean") {
              draft.runtimeDebug.slowFrameDiagnosticsEnabled = settings.slowFrameDiagnosticsEnabled;
            }
            if (
              typeof settings.slowFrameDiagnosticsThresholdMs === "number" &&
              Number.isFinite(settings.slowFrameDiagnosticsThresholdMs)
            ) {
              draft.runtimeDebug.slowFrameDiagnosticsThresholdMs = Math.max(1, settings.slowFrameDiagnosticsThresholdMs);
            }
            if (typeof settings.heartbeatLoggingEnabled === "boolean") {
              draft.runtimeDebug.heartbeatLoggingEnabled = settings.heartbeatLoggingEnabled;
            }
          })
        });
      },
      setStats(stats) {
        set({
          state: produce(get().state, (draft) => {
            draft.stats = { ...draft.stats, ...stats };
          })
        });
      },
      setActorStatus(actorId, status) {
        set({
          state: produce(get().state, (draft) => {
            if (status === null) {
              delete draft.actorStatusByActorId[actorId];
              return;
            }
            draft.actorStatusByActorId[actorId] = status;
          })
        });
      },
      setInteractionTool(tool) {
        set({
          state: produce(get().state, (draft) => {
            draft.interactionTool = tool;
          })
        });
      },
      setDimensionSnap(partial) {
        set({
          state: produce(get().state, (draft) => {
            draft.dimensionSnap = { ...draft.dimensionSnap, ...partial };
          })
        });
      },
      setDimensionSnapHover(hover) {
        set({
          state: produce(get().state, (draft) => {
            draft.dimensionSnapHover = hover;
          })
        });
      },
      setActorFrameTimings(timings) {
        set({
          state: produce(get().state, (draft) => {
            draft.actorFrameTimingsMs = timings;
          })
        });
      },
      createMaterial(input) {
        const id = createId("mat");
        const nameBase = input?.name ?? "New Material";
        const usedNames = new Set(Object.values(get().state.materials).map((m) => m.name));
        let name = nameBase;
        let suffix = 2;
        while (usedNames.has(name)) {
          name = `${nameBase} ${suffix}`;
          suffix += 1;
        }

        const newMaterial: Material = {
          id,
          name,
          albedo: { mode: "color", color: "#ffffff" },
          metalness: { mode: "scalar", value: 0 },
          roughness: { mode: "scalar", value: 0.5 },
          normalMap: null,
          emissive: { mode: "color", color: "#000000" },
          emissiveIntensity: 0,
          opacity: 1,
          transparent: false,
          side: "front",
          wireframe: false,
          ...input
        };

        withHistory(get, set, "Create material");
        set({
          state: produce(get().state, (draft) => {
            draft.materials[id] = newMaterial;
            draft.dirty = true;
          })
        });
        return id;
      },
      createMaterialFromDef(def) {
        const id = createId("mat");
        const newMaterial: Material = { id, ...def };
        set({
          state: produce(get().state, (draft) => {
            draft.materials[id] = newMaterial;
            draft.dirty = true;
          })
        });
        return id;
      },
      addAssets(assets) {
        if (assets.length === 0) {
          return;
        }
        set({
          state: produce(get().state, (draft) => {
            for (const asset of assets) {
              if (!draft.assets.some((a) => a.id === asset.id)) {
                draft.assets.push(asset);
              }
            }
            draft.dirty = true;
          })
        });
      },
      removeAsset(assetId) {
        set({
          state: produce(get().state, (draft) => {
            const idx = draft.assets.findIndex((a) => a.id === assetId);
            if (idx === -1) return;
            draft.assets.splice(idx, 1);
            draft.dirty = true;
          })
        });
      },
      updateMaterial(materialId, partial) {
        withHistory(get, set, "Update material");
        set({
          state: produce(get().state, (draft) => {
            const material = draft.materials[materialId];
            if (material) {
              Object.assign(material, partial);
            }
            draft.dirty = true;
          })
        });
      },
      deleteMaterial(materialId) {
        withHistory(get, set, "Delete material");
        set({
          state: produce(get().state, (draft) => {
            delete draft.materials[materialId];
            // Clear material references from actors
            for (const actor of Object.values(draft.actors)) {
              if (actor.params.materialId === materialId) {
                delete actor.params.materialId;
              }
            }
            draft.dirty = true;
          })
        });
      }
    }
  }));
}

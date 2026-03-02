import { create, type StoreApi, type UseBoundStore } from "zustand";
import { produce } from "immer";
import { createId } from "@/core/ids";
import { createInitialState, DEFAULT_CAMERA } from "@/core/defaults";
import type {
  ActorNode,
  AppState,
  CameraPreset,
  ConsoleLogEntry,
  ComponentNode,
  LogLevel,
  ParameterValues,
  SceneStats,
  SelectionEntry,
  TimeSpeedPreset
} from "@/core/types";
import type { AppMode } from "@/types/ipc";

export interface HistoryEntry {
  label: string;
  snapshot: AppState;
}

export interface AppActions {
  hydrate(nextState: AppState): void;
  setMode(mode: AppMode): void;
  setStatus(message: string): void;
  addLog(entry: { level: LogLevel; message: string; details?: string }): void;
  clearLogs(): void;
  setDirty(dirty: boolean): void;
  pushHistory(label: string): void;
  undo(): void;
  redo(): void;
  setSessionName(name: string): void;
  createActor(input: {
    actorType: ActorNode["actorType"];
    name?: string;
    parentActorId?: string | null;
    pluginType?: string;
  }): string;
  deleteSelection(): void;
  renameNode(node: SelectionEntry, name: string): void;
  setActorTransform(actorId: string, key: "position" | "rotation" | "scale", value: [number, number, number]): void;
  setNodeEnabled(node: SelectionEntry, enabled: boolean): void;
  select(nodes: SelectionEntry[], additive?: boolean): void;
  clearSelection(): void;
  reorderActor(actorId: string, newParentId: string | null, index: number): void;
  updateComponentParams(componentId: string, partial: ParameterValues): void;
  updateActorParams(actorId: string, partial: ParameterValues): void;
  setTimeRunning(running: boolean): void;
  stepTime(stepMultiplier?: number): void;
  setTimeSpeed(speed: TimeSpeedPreset): void;
  applyCameraPreset(preset: CameraPreset): void;
  setCameraState(camera: Partial<AppState["camera"]>, markDirty?: boolean): void;
  saveCameraBookmark(name: string): void;
  loadCameraBookmark(id: string): void;
  removeCameraBookmark(id: string): void;
  setStats(stats: Partial<SceneStats>): void;
  setActorStatus(actorId: string, status: AppState["actorStatusByActorId"][string] | null): void;
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

const MAX_CONSOLE_LOGS = 500;

function appendConsoleLog(state: AppState, entry: { level: LogLevel; message: string; details?: string }): void {
  const log: ConsoleLogEntry = {
    id: createId("log"),
    level: entry.level,
    message: entry.message,
    details: entry.details,
    timestampIso: new Date().toISOString()
  };
  state.consoleLogs = [...state.consoleLogs, log].slice(-MAX_CONSOLE_LOGS);
}

function withHistory(get: () => AppStore, set: (partial: Partial<AppStore>) => void, label: string): void {
  const snapshot = cloneState(get().state);
  const nextPast = [...get().historyPast, { label, snapshot }];
  set({
    historyPast: nextPast,
    historyFuture: []
  });
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
  state.selection = state.selection.filter((entry) => entry.id !== actorId);
}

function cameraForPreset(preset: CameraPreset): AppState["camera"] {
  if (preset === "perspective") {
    return { ...DEFAULT_CAMERA, mode: "perspective" };
  }

  if (preset === "isometric") {
    return {
      ...DEFAULT_CAMERA,
      mode: "orthographic",
      position: [8, 8, 8]
    };
  }

  const base = {
    ...DEFAULT_CAMERA,
    mode: "orthographic" as const
  };

  switch (preset) {
    case "top":
      return { ...base, position: [0, 15, 0.001] };
    case "left":
      return { ...base, position: [-15, 0, 0] };
    case "front":
      return { ...base, position: [0, 0, 15] };
    case "back":
      return { ...base, position: [0, 0, -15] };
    default:
      return base;
  }
}

export function createAppStore(mode: AppMode): AppStoreApi {
  const initial = createInitialState(mode);
  return create<AppStore>((set, get) => ({
    state: initial,
    historyPast: [],
    historyFuture: [],
    actions: {
      hydrate(nextState) {
        set({
          state: nextState,
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
      clearLogs() {
        set({
          state: produce(get().state, (draft) => {
            draft.consoleLogs = [];
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
      setSessionName(name) {
        set({
          state: produce(get().state, (draft) => {
            draft.activeSessionName = name;
            draft.dirty = true;
          })
        });
      },
      createActor({ actorType, name, parentActorId = null, pluginType }) {
        const id = createId("actor");
        const newActor: ActorNode = {
          id,
          name: name ?? `${actorType} actor`,
          enabled: true,
          kind: "actor",
          actorType,
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

        withHistory(get, set, "Create actor");
        set({
          state: produce(get().state, (draft) => {
            draft.actors[id] = newActor;
            if (parentActorId) {
              draft.actors[parentActorId]?.childActorIds.push(id);
            } else {
              draft.scene.actorIds.push(id);
            }
            draft.selection = [{ kind: "actor", id }];
            draft.stats.actorCount = Object.keys(draft.actors).length;
            draft.dirty = true;
          })
        });
        return id;
      },
      deleteSelection() {
        if (get().state.mode === "web-ro") {
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
            draft.dirty = true;
          })
        });
      },
      renameNode(node, name) {
        withHistory(get, set, "Rename node");
        set({
          state: produce(get().state, (draft) => {
            if (node.kind === "actor") {
              const actor = draft.actors[node.id];
              if (actor) {
                actor.name = name;
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
      setNodeEnabled(node, enabled) {
        withHistory(get, set, "Toggle enabled");
        set({
          state: produce(get().state, (draft) => {
            if (node.kind === "actor") {
              const actor = draft.actors[node.id];
              if (actor) {
                actor.enabled = enabled;
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
        withHistory(get, set, "Reparent actor");
        set({
          state: produce(get().state, (draft) => {
            const actor = draft.actors[actorId];
            if (!actor) {
              return;
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
            targetList.splice(index, 0, actorId);
            draft.dirty = true;
          })
        });
      },
      updateComponentParams(componentId, partial) {
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
      applyCameraPreset(preset) {
        set({
          state: produce(get().state, (draft) => {
            draft.camera = cameraForPreset(preset);
            draft.dirty = true;
          })
        });
      },
      setCameraState(camera, markDirty = true) {
        set({
          state: produce(get().state, (draft) => {
            draft.camera = { ...draft.camera, ...camera };
            if (markDirty) {
              draft.dirty = true;
            }
          })
        });
      },
      saveCameraBookmark(name) {
        withHistory(get, set, "Save camera bookmark");
        set({
          state: produce(get().state, (draft) => {
            draft.cameraBookmarks.push({
              id: createId("bookmark"),
              name,
              camera: structuredClone(draft.camera)
            });
            draft.dirty = true;
          })
        });
      },
      loadCameraBookmark(id) {
        set({
          state: produce(get().state, (draft) => {
            const bookmark = draft.cameraBookmarks.find((entry) => entry.id === id);
            if (bookmark) {
              draft.camera = structuredClone(bookmark.camera);
            }
          })
        });
      },
      removeCameraBookmark(id) {
        withHistory(get, set, "Remove camera bookmark");
        set({
          state: produce(get().state, (draft) => {
            draft.cameraBookmarks = draft.cameraBookmarks.filter((entry) => entry.id !== id);
            draft.dirty = true;
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
      }
    }
  }));
}

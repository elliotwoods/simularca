import { create, type StoreApi, type UseBoundStore } from "zustand";
import { produce } from "immer";
import { createId } from "@/core/ids";
import { createInitialState, DEFAULT_CAMERA } from "@/core/defaults";
import type {
  ActorNode,
  ActorVisibilityMode,
  AppState,
  CameraPreset,
  ConsoleCommandEntry,
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
  appendCommandEntry(entry: Omit<ConsoleCommandEntry, "id" | "kind" | "timestampIso"> & { source: string }): string;
  updateCommandEntry(entryId: string, patch: Partial<Omit<ConsoleCommandEntry, "id" | "kind" | "source" | "timestampIso">>): void;
  clearLogs(): void;
  setDirty(dirty: boolean): void;
  pushHistory(label: string): void;
  undo(): void;
  redo(): void;
  setSessionName(name: string): void;
  setSceneBackgroundColor(color: string): void;
  createActor(input: {
    actorType: ActorNode["actorType"];
    name?: string;
    parentActorId?: string | null;
    pluginType?: string;
  }): string;
  deleteSelection(): void;
  renameNode(node: SelectionEntry, name: string): void;
  setActorTransform(actorId: string, key: "position" | "rotation" | "scale", value: [number, number, number]): void;
  setActorVisibilityMode(actorId: string, mode: ActorVisibilityMode): void;
  setNodeEnabled(node: SelectionEntry, enabled: boolean): void;
  select(nodes: SelectionEntry[], additive?: boolean): void;
  clearSelection(): void;
  reorderActor(actorId: string, newParentId: string | null, index: number): void;
  updateComponentParams(componentId: string, partial: ParameterValues): void;
  updateActorParams(actorId: string, partial: ParameterValues): void;
  updateActorParamsNoHistory(actorId: string, partial: ParameterValues): void;
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

function withHistory(get: () => AppStore, set: (partial: Partial<AppStore>) => void, label: string): void {
  const snapshot = cloneState(get().state);
  const nextPast = [...get().historyPast, { label, snapshot }];
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
      setSessionName(name) {
        set({
          state: produce(get().state, (draft) => {
            draft.activeSessionName = name;
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
      createActor({ actorType, name, parentActorId = null, pluginType }) {
        const id = createId("actor");
        const currentActors = get().state.actors;
        const uniqueName = uniqueActorName(currentActors, name ?? `${actorType} actor`);
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
            draft.stats.actorCountEnabled = Object.values(draft.actors).filter((entry) => entry.enabled).length;
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
            draft.stats.actorCountEnabled = Object.values(draft.actors).filter((entry) => entry.enabled).length;
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
      setActorVisibilityMode(actorId, mode) {
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
      updateActorParamsNoHistory(actorId, partial) {
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

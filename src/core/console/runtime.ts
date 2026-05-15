import type { AppKernel } from "@/app/kernel";
import type { ActorNode, ActorVisibilityMode, CameraState, ComponentNode, ParameterValues, SelectionEntry } from "@/core/types";
import { createActorFromDescriptor, listActorCreationOptions } from "@/features/actors/actorCatalog";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";
import { cameraStatesApproximatelyEqual, diffCameraStates, readViewportCameraState } from "@/render/cameraSync";

import { toCompactYaml } from "./consoleUtils";

export interface ConsoleMethodDoc {
  path: string;
  signature: string;
  description: string;
  examples: string[];
}

export interface ConsoleCompletion {
  label: string;
  insertText: string;
  detail: string;
  documentation?: string;
}

export interface ConsoleExecutionSuccess {
  ok: true;
  summary: string;
  result?: unknown;
  details?: string;
}

export interface ConsoleExecutionError {
  ok: false;
  summary: string;
  error: string;
  details?: string;
}

export type ConsoleExecutionResult = ConsoleExecutionSuccess | ConsoleExecutionError;

export interface DebugExecutionOptions {
  extraScope?: Record<string, unknown>;
}

const METHOD_DOCS: ConsoleMethodDoc[] = [
  { path: "help", signature: "help()", description: "List available JS console APIs.", examples: ["help()"] },
  { path: "scene.stats", signature: "scene.stats()", description: "Return scene stats.", examples: ["scene.stats()"] },
  {
    path: "scene.profile.state",
    signature: "scene.profile.state()",
    description: "Return live profiler capture state.",
    examples: ["scene.profile.state()"]
  },
  {
    path: "scene.profile.latestSummary",
    signature: "scene.profile.latestSummary()",
    description: "Return the latest completed profiler result as compact LLM-readable JSON.",
    examples: ["scene.profile.latestSummary()"]
  },
  {
    path: "scene.profile.latestRaw",
    signature: "scene.profile.latestRaw()",
    description: "Return the full latest completed profiler capture tree.",
    examples: ["scene.profile.latestRaw()"]
  },
  {
    path: "scene.listActors",
    signature: "scene.listActors(filter?)",
    description: "List actors with optional filter.",
    examples: ["scene.listActors()", "scene.listActors({ type: 'mesh' })"]
  },
  {
    path: "scene.clear",
    signature: "scene.clear({ confirm: true })",
    description: "Delete all actors from the scene.",
    examples: ["scene.clear({ confirm: true })"]
  },
  {
    path: "actor.list",
    signature: "actor.list(filter?)",
    description: "List actors.",
    examples: ["actor.list()", "actor.list({ nameIncludes: 'Tree' })"]
  },
  {
    path: "actor.create",
    signature: "actor.create({ type, name?, parent? })",
    description: "Create an actor.",
    examples: ["actor.create({ type: 'primitive', name: 'Cube' })"]
  },
  {
    path: "actor.select",
    signature: "actor.select(target, options?)",
    description: "Select actors by target.",
    examples: ["actor.select('@selected')", "actor.select({ name: 'Cube' })"]
  },
  {
    path: "actor.rename",
    signature: "actor.rename(target, name)",
    description: "Rename target actors.",
    examples: ["actor.rename({ name: 'Cube' }, 'Box')"]
  },
  { path: "actor.enable", signature: "actor.enable(target)", description: "Enable actors.", examples: ["actor.enable('@selected')"] },
  { path: "actor.disable", signature: "actor.disable(target)", description: "Disable actors.", examples: ["actor.disable('@selected')"] },
  {
    path: "actor.remove",
    signature: "actor.remove(target, { confirm: true })",
    description: "Delete actors.",
    examples: ["actor.remove({ name: 'Cube' }, { confirm: true })"]
  },
  {
    path: "actor.reparent",
    signature: "actor.reparent(target, { parent?, index? })",
    description: "Reparent actors.",
    examples: ["actor.reparent({ name: 'Cube' }, { parent: null, index: 0 })"]
  },
  {
    path: "actor.transform.set",
    signature: "actor.transform.set(target, patch)",
    description: "Set transform values.",
    examples: ["actor.transform.set('@selected', { position: [0, 1, 0] })"]
  },
  {
    path: "actor.params.get",
    signature: "actor.params.get(target, key?)",
    description: "Get actor params.",
    examples: ["actor.params.get('@selected')"]
  },
  {
    path: "actor.params.set",
    signature: "actor.params.set(target, patch)",
    description: "Set actor params.",
    examples: ["actor.params.set('@selected', { opacity: 0.5 })"]
  },
  {
    path: "actor.visibility.get",
    signature: "actor.visibility.get(target)",
    description: "Get actor visibility mode.",
    examples: ["actor.visibility.get('@selected')"]
  },
  {
    path: "actor.visibility.set",
    signature: "actor.visibility.set(target, mode)",
    description: "Set actor visibility mode.",
    examples: ["actor.visibility.set('@selected', 'hidden')"]
  },
  { path: "component.list", signature: "component.list(filter?)", description: "List components.", examples: ["component.list()"] },
  { path: "component.select", signature: "component.select(target, options?)", description: "Select components.", examples: ["component.select('@selected')"] },
  { path: "component.enable", signature: "component.enable(target)", description: "Enable components.", examples: ["component.enable('@selected')"] },
  { path: "component.disable", signature: "component.disable(target)", description: "Disable components.", examples: ["component.disable('@selected')"] },
  { path: "component.params.get", signature: "component.params.get(target, key?)", description: "Get component params.", examples: ["component.params.get('@selected')"] },
  { path: "component.params.set", signature: "component.params.set(target, patch)", description: "Set component params.", examples: ["component.params.set('@selected', { foo: 1 })"] },
  { path: "project.list", signature: "project.list()", description: "List projects.", examples: ["project.list()"] },
  { path: "project.status", signature: "project.status()", description: "Get current project status.", examples: ["project.status()"] },
  { path: "project.new", signature: "project.new(name)", description: "Create and load a new project.", examples: ["project.new('Sandbox')"] },
  { path: "project.load", signature: "project.load(name, snapshot?)", description: "Load a project snapshot.", examples: ["project.load('demo', 'main')"] },
  { path: "project.reload", signature: "project.reload()", description: "Reload active project snapshot.", examples: ["project.reload()"] },
  { path: "project.save", signature: "project.save()", description: "Save active project snapshot.", examples: ["project.save()"] },
  { path: "project.rename", signature: "project.rename(nextName)", description: "Rename active project.", examples: ["project.rename('Project A')"] },
  { path: "project.snapshots.list", signature: "project.snapshots.list()", description: "List snapshots in the active project.", examples: ["project.snapshots.list()"] },
  { path: "project.snapshots.saveAs", signature: "project.snapshots.saveAs(name)", description: "Save current state as a named snapshot.", examples: ["project.snapshots.saveAs('lighting-pass')"] },
  { path: "project.snapshots.rename", signature: "project.snapshots.rename(nextName)", description: "Rename active snapshot.", examples: ["project.snapshots.rename('draft-2')"] },
  { path: "project.snapshots.duplicate", signature: "project.snapshots.duplicate(name)", description: "Duplicate active snapshot.", examples: ["project.snapshots.duplicate('backup')"] },
  { path: "project.snapshots.delete", signature: "project.snapshots.delete(name?)", description: "Delete a snapshot.", examples: ["project.snapshots.delete('backup')"] },
  { path: "time.play", signature: "time.play()", description: "Start simulation.", examples: ["time.play()"] },
  { path: "time.pause", signature: "time.pause()", description: "Pause simulation.", examples: ["time.pause()"] },
  { path: "time.toggle", signature: "time.toggle()", description: "Toggle simulation.", examples: ["time.toggle()"] },
  { path: "time.step", signature: "time.step(frames?)", description: "Step simulation.", examples: ["time.step()", "time.step(5)"] },
  { path: "time.speed", signature: "time.speed(value)", description: "Set simulation speed preset.", examples: ["time.speed(2)"] },
  { path: "camera.preset", signature: "camera.preset(name)", description: "Apply camera preset.", examples: ["camera.preset('isometric')"] },
  { path: "camera.state", signature: "camera.state()", description: "Get current camera.", examples: ["camera.state()"] },
  { path: "camera.debug", signature: "camera.debug()", description: "Inspect live/store camera sync state.", examples: ["camera.debug()"] },
  { path: "app.undo", signature: "app.undo()", description: "Undo.", examples: ["app.undo()"] },
  { path: "app.redo", signature: "app.redo()", description: "Redo.", examples: ["app.redo()"] },
  { path: "window.state", signature: "window.state()", description: "Get desktop window state.", examples: ["window.state()"] },
  { path: "window.minimize", signature: "window.minimize()", description: "Minimize desktop window.", examples: ["window.minimize()"] },
  { path: "window.maximize", signature: "window.maximize()", description: "Toggle maximize/restore desktop window.", examples: ["window.maximize()"] },
  { path: "window.close", signature: "window.close({ confirm: true })", description: "Close desktop window.", examples: ["window.close({ confirm: true })"] },
  { path: "plugin.list", signature: "plugin.list()", description: "List loaded plugins.", examples: ["plugin.list()"] },
  { path: "plugin.load", signature: "plugin.load(modulePath)", description: "Load plugin module path.", examples: ["plugin.load('file:///absolute/path/to/plugin/dist/index.js')"] }
];

type TargetInput = "@selected" | string | { id?: string; name?: string } | Array<"@selected" | string | { id?: string; name?: string }>;

interface ViewportDebugRuntime {
  constructor?: { name?: string };
  activeCamera?: {
    position: { x: number; y: number; z: number };
    near: number;
    far: number;
    fov?: number;
    zoom?: number;
    isPerspectiveCamera?: boolean;
    isOrthographicCamera?: boolean;
  };
  controls?: {
    enabled?: boolean;
    target?: { x: number; y: number; z: number };
  };
  cameraController?: { mode?: string; pointerId?: number | null; pointerButton?: number | null };
  actorTransformController?: { mode?: string; pendingOrbitBlock?: boolean };
  curveEditController?: { activeActorId?: string | null; pendingOrbitBlock?: boolean };
  lastAppliedCameraState?: CameraState | null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function serializeResult(result: unknown): string {
  if (result === undefined) {
    return "undefined";
  }
  return toCompactYaml(result).trim();
}

function findActiveViewportRuntime(): ViewportDebugRuntime | null {
  if (typeof document === "undefined") {
    return null;
  }
  const root = document.querySelector(".viewport-panel") ?? document.querySelector("canvas");
  if (!root) {
    return null;
  }
  const fiberKey = Object.keys(root).find((key) => key.startsWith("__reactFiber$"));
  let fiber = fiberKey ? (root as unknown as Record<string, unknown>)[fiberKey] : null;
  while (fiber && typeof fiber === "object") {
    const typed = fiber as { type?: { name?: string }; elementType?: { name?: string }; return?: unknown; memoizedState?: unknown };
    if ((typed.type?.name ?? typed.elementType?.name) === "ViewportPanel") {
      let hook = typed.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
      while (hook) {
        const memoizedState = hook.memoizedState as { current?: unknown } | null;
        const current = memoizedState?.current as { constructor?: { name?: string } } | undefined;
        const name = current?.constructor?.name;
        if (name === "WebGlViewport" || name === "WebGpuViewport") {
          return current as ViewportDebugRuntime;
        }
        hook = (hook.next as { memoizedState?: unknown; next?: unknown } | null) ?? null;
      }
      return null;
    }
    fiber = (typed.return as unknown) ?? null;
  }
  return null;
}

function buildCameraDebug(kernel: AppKernel) {
  const storeCamera = kernel.store.getState().state.camera;
  const viewport = findActiveViewportRuntime();
  if (!viewport) {
    return {
      available: false,
      backend: kernel.store.getState().state.scene.renderEngine,
      storeCamera
    };
  }
  const controlsTarget = viewport.controls?.target;
  const activeCamera = viewport.activeCamera;
  const liveCamera =
    activeCamera && controlsTarget
      ? readViewportCameraState(
          activeCamera as unknown as Parameters<typeof readViewportCameraState>[0],
          controlsTarget as Parameters<typeof readViewportCameraState>[1],
          storeCamera
        )
      : null;
  return {
    available: true,
    backend: kernel.store.getState().state.scene.renderEngine,
    storeCamera,
    liveCamera,
    liveMatchesStore: liveCamera ? cameraStatesApproximatelyEqual(liveCamera, storeCamera) : null,
    liveVsStoreDiff: liveCamera ? diffCameraStates(liveCamera, storeCamera) : null,
    lastAppliedCameraState: viewport.lastAppliedCameraState ?? null,
    viewport: {
      type: viewport.constructor?.name ?? "unknown",
      controlsEnabled: viewport.controls?.enabled ?? null,
      cameraControllerMode: viewport.cameraController?.mode ?? null,
      pointerId: viewport.cameraController?.pointerId ?? null,
      pointerButton: viewport.cameraController?.pointerButton ?? null,
      actorTransformMode: viewport.actorTransformController?.mode ?? null,
      actorTransformPendingOrbitBlock: viewport.actorTransformController?.pendingOrbitBlock ?? null,
      curveActorId: viewport.curveEditController?.activeActorId ?? null,
      curvePendingOrbitBlock: viewport.curveEditController?.pendingOrbitBlock ?? null
    }
  };
}

function assertWritable(kernel: AppKernel): void {
  if (kernel.store.getState().state.mode === "web-ro") {
    throw new Error("This command is unavailable in read-only web mode.");
  }
}

function resolveActorTargets(kernel: AppKernel, input: TargetInput): ActorNode[] {
  const state = kernel.store.getState().state;
  const values = Array.isArray(input) ? input : [input];
  const resolved: ActorNode[] = [];
  for (const value of values) {
    if (value === "@selected") {
      resolved.push(
        ...state.selection
          .filter((entry) => entry.kind === "actor")
          .map((entry) => state.actors[entry.id])
          .filter((actor): actor is ActorNode => Boolean(actor))
      );
      continue;
    }
    if (typeof value === "string") {
      const byId = state.actors[value];
      if (byId) {
        resolved.push(byId);
        continue;
      }
      const byName = Object.values(state.actors).filter((actor) => actor.name === value);
      if (byName.length === 1) {
        const first = byName[0];
        if (first) {
          resolved.push(first);
        }
        continue;
      }
      if (byName.length > 1) {
        throw new Error(`Actor name '${value}' is ambiguous (${byName.map((actor) => actor.id).join(", ")}).`);
      }
      throw new Error(`Actor target not found: ${value}`);
    }
    if (value.id) {
      const byId = state.actors[value.id];
      if (!byId) {
        throw new Error(`Actor id not found: ${value.id}`);
      }
      resolved.push(byId);
      continue;
    }
    if (value.name) {
      const byName = Object.values(state.actors).filter((actor) => actor.name === value.name);
      if (byName.length === 0) {
        throw new Error(`Actor name not found: ${value.name}`);
      }
      if (byName.length > 1) {
        throw new Error(`Actor name '${value.name}' is ambiguous (${byName.map((actor) => actor.id).join(", ")}).`);
      }
      const first = byName[0];
      if (first) {
        resolved.push(first);
      }
      continue;
    }
    throw new Error("Invalid actor target.");
  }
  if (resolved.length === 0) {
    throw new Error("No actor targets resolved.");
  }
  return resolved.filter((actor, index, list) => list.findIndex((entry) => entry.id === actor.id) === index);
}

function resolveComponentTargets(kernel: AppKernel, input: TargetInput): ComponentNode[] {
  const state = kernel.store.getState().state;
  const values = Array.isArray(input) ? input : [input];
  const resolved: ComponentNode[] = [];
  for (const value of values) {
    if (value === "@selected") {
      resolved.push(
        ...state.selection
          .filter((entry) => entry.kind === "component")
          .map((entry) => state.components[entry.id])
          .filter((component): component is ComponentNode => Boolean(component))
      );
      continue;
    }
    if (typeof value === "string") {
      const byId = state.components[value];
      if (byId) {
        resolved.push(byId);
        continue;
      }
      const byName = Object.values(state.components).filter((component) => component.name === value);
      if (byName.length === 1) {
        const first = byName[0];
        if (first) {
          resolved.push(first);
        }
        continue;
      }
      if (byName.length > 1) {
        throw new Error(`Component name '${value}' is ambiguous (${byName.map((component) => component.id).join(", ")}).`);
      }
      throw new Error(`Component target not found: ${value}`);
    }
    if (value.id) {
      const byId = state.components[value.id];
      if (!byId) {
        throw new Error(`Component id not found: ${value.id}`);
      }
      resolved.push(byId);
      continue;
    }
    if (value.name) {
      const byName = Object.values(state.components).filter((component) => component.name === value.name);
      if (byName.length === 0) {
        throw new Error(`Component name not found: ${value.name}`);
      }
      if (byName.length > 1) {
        throw new Error(`Component name '${value.name}' is ambiguous (${byName.map((component) => component.id).join(", ")}).`);
      }
      const first = byName[0];
      if (first) {
        resolved.push(first);
      }
      continue;
    }
    throw new Error("Invalid component target.");
  }
  if (resolved.length === 0) {
    throw new Error("No component targets resolved.");
  }
  return resolved.filter((component, index, list) => list.findIndex((entry) => entry.id === component.id) === index);
}

function normalizeVector3(input: unknown, current: [number, number, number]): [number, number, number] {
  if (!Array.isArray(input) || input.length !== 3) {
    return current;
  }
  const values = input.map((value) => Number(value));
  if (!values.every((value) => Number.isFinite(value))) {
    return current;
  }
  return [values[0], values[1], values[2]] as [number, number, number];
}

function buildHelp() {
  return {
    methods: METHOD_DOCS.map((entry) => ({
      path: entry.path,
      signature: entry.signature,
      description: entry.description
    })),
    topic(path: string) {
      const entry = METHOD_DOCS.find((item) => item.path === path || item.signature.startsWith(`${path}(`));
      if (!entry) {
        throw new Error(`No help topic found for '${path}'.`);
      }
      return entry;
    },
    search(query: string) {
      const normalized = query.trim().toLowerCase();
      return METHOD_DOCS.filter((entry) => {
        return (
          entry.path.toLowerCase().includes(normalized) ||
          entry.signature.toLowerCase().includes(normalized) ||
          entry.description.toLowerCase().includes(normalized)
        );
      });
    }
  };
}

function buildRuntimeApi(kernel: AppKernel) {
  const scene = {
    stats() {
      return kernel.store.getState().state.stats;
    },
    profile: {
      state() {
        return kernel.profiler.getState();
      },
      latestSummary() {
        return kernel.profiler.getLatestSummary();
      },
      latestRaw() {
        return kernel.profiler.getLatestResult();
      }
    },
    listActors(filter?: { type?: string; nameIncludes?: string; enabled?: boolean }) {
      return Object.values(kernel.store.getState().state.actors).filter((actor) => {
        if (filter?.type && actor.actorType !== filter.type) {
          return false;
        }
        if (filter?.nameIncludes && !actor.name.toLowerCase().includes(filter.nameIncludes.toLowerCase())) {
          return false;
        }
        if (typeof filter?.enabled === "boolean" && actor.enabled !== filter.enabled) {
          return false;
        }
        return true;
      });
    },
    clear(options?: { confirm?: boolean }) {
      assertWritable(kernel);
      if (!options?.confirm) {
        throw new Error("scene.clear requires { confirm: true }.");
      }
      const state = kernel.store.getState().state;
      const actorIds = Object.keys(state.actors);
      kernel.store.getState().actions.select(actorIds.map((id) => ({ kind: "actor", id })));
      kernel.store.getState().actions.deleteSelection();
      return { removedActors: actorIds.length };
    }
  };

  const actor = {
    list(filter?: { type?: string; nameIncludes?: string; enabled?: boolean }) {
      return scene.listActors(filter);
    },
    create(input: { type: string; name?: string; parent?: TargetInput }) {
      assertWritable(kernel);
      const options = listActorCreationOptions(kernel);
      const match = options.find((entry) => entry.actorType === input.type || entry.descriptorId === input.type);
      if (!match) {
        throw new Error(`Unknown actor type: ${input.type}`);
      }
      const actorId = createActorFromDescriptor(kernel, match.descriptorId);
      if (!actorId) {
        throw new Error(`Unable to create actor for descriptor: ${match.descriptorId}`);
      }
      if (input.name?.trim()) {
        kernel.store.getState().actions.renameNode({ kind: "actor", id: actorId }, input.name.trim());
      }
      if (input.parent !== undefined && input.parent !== null) {
        const parent = resolveActorTargets(kernel, input.parent)[0];
        if (!parent) {
          throw new Error("Parent actor target not found.");
        }
        kernel.store.getState().actions.reorderActor(actorId, parent.id, parent.childActorIds.length);
      }
      return kernel.store.getState().state.actors[actorId];
    },
    select(target: TargetInput, options?: { additive?: boolean }) {
      const targets = resolveActorTargets(kernel, target);
      const selection: SelectionEntry[] = targets.map((entry) => ({ kind: "actor", id: entry.id }));
      kernel.store.getState().actions.select(selection, Boolean(options?.additive));
      return selection;
    },
    rename(target: TargetInput, name: string) {
      assertWritable(kernel);
      const targets = resolveActorTargets(kernel, target);
      for (const entry of targets) {
        kernel.store.getState().actions.renameNode({ kind: "actor", id: entry.id }, name);
      }
      return { renamed: targets.length };
    },
    enable(target: TargetInput) {
      assertWritable(kernel);
      const targets = resolveActorTargets(kernel, target);
      for (const entry of targets) {
        kernel.store.getState().actions.setNodeEnabled({ kind: "actor", id: entry.id }, true);
      }
      return { enabled: targets.length };
    },
    disable(target: TargetInput) {
      assertWritable(kernel);
      const targets = resolveActorTargets(kernel, target);
      for (const entry of targets) {
        kernel.store.getState().actions.setNodeEnabled({ kind: "actor", id: entry.id }, false);
      }
      return { disabled: targets.length };
    },
    remove(target: TargetInput, options?: { confirm?: boolean }) {
      assertWritable(kernel);
      if (!options?.confirm) {
        throw new Error("actor.remove requires { confirm: true }.");
      }
      const targets = resolveActorTargets(kernel, target);
      kernel.store.getState().actions.select(targets.map((entry) => ({ kind: "actor", id: entry.id })));
      kernel.store.getState().actions.deleteSelection();
      return { removed: targets.length };
    },
    reparent(target: TargetInput, options: { parent?: TargetInput | null; index?: number }) {
      assertWritable(kernel);
      const targets = resolveActorTargets(kernel, target);
      const parent =
        options.parent === null || options.parent === undefined
          ? null
          : (() => {
              const resolved = resolveActorTargets(kernel, options.parent);
              const first = resolved[0];
              if (!first) {
                throw new Error("Parent actor target not found.");
              }
              return first;
            })();
      for (const entry of targets) {
        const index = Number.isFinite(options.index) ? Math.max(0, Math.floor(Number(options.index))) : 0;
        kernel.store.getState().actions.reorderActor(entry.id, parent?.id ?? null, index);
      }
      return { moved: targets.length, parentId: parent?.id ?? null };
    },
    transform: {
      set(target: TargetInput, patch: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }) {
        assertWritable(kernel);
        const targets = resolveActorTargets(kernel, target);
        for (const entry of targets) {
          if (patch.position) {
            kernel.store.getState().actions.setActorTransform(entry.id, "position", normalizeVector3(patch.position, entry.transform.position));
          }
          if (patch.rotation) {
            kernel.store.getState().actions.setActorTransform(entry.id, "rotation", normalizeVector3(patch.rotation, entry.transform.rotation));
          }
          if (patch.scale) {
            kernel.store.getState().actions.setActorTransform(entry.id, "scale", normalizeVector3(patch.scale, entry.transform.scale));
          }
        }
        return { updated: targets.length };
      }
    },
    params: {
      get(target: TargetInput, key?: string) {
        const targets = resolveActorTargets(kernel, target);
        return targets.map((entry) => ({
          actorId: entry.id,
          name: entry.name,
          params: key ? entry.params[key] : entry.params
        }));
      },
      set(target: TargetInput, patch: Record<string, unknown>) {
        assertWritable(kernel);
        const targets = resolveActorTargets(kernel, target);
        for (const entry of targets) {
          kernel.store.getState().actions.updateActorParams(entry.id, patch as ParameterValues);
        }
        return { updated: targets.length };
      }
    },
    visibility: {
      get(target: TargetInput) {
        const targets = resolveActorTargets(kernel, target);
        return targets.map((entry) => ({
          actorId: entry.id,
          name: entry.name,
          visibilityMode: entry.visibilityMode ?? "visible"
        }));
      },
      set(target: TargetInput, mode: ActorVisibilityMode) {
        assertWritable(kernel);
        if (mode !== "visible" && mode !== "hidden" && mode !== "selected") {
          throw new Error("Invalid visibility mode. Use 'visible', 'hidden', or 'selected'.");
        }
        const targets = resolveActorTargets(kernel, target);
        for (const entry of targets) {
          kernel.store.getState().actions.setActorVisibilityMode(entry.id, mode);
        }
        return { updated: targets.length, mode };
      }
    }
  };

  const component = {
    list(filter?: { actorId?: string; componentType?: string; enabled?: boolean }) {
      return Object.values(kernel.store.getState().state.components).filter((entry) => {
        if (filter?.actorId && entry.parentActorId !== filter.actorId) {
          return false;
        }
        if (filter?.componentType && entry.componentType !== filter.componentType) {
          return false;
        }
        if (typeof filter?.enabled === "boolean" && entry.enabled !== filter.enabled) {
          return false;
        }
        return true;
      });
    },
    select(target: TargetInput, options?: { additive?: boolean }) {
      const targets = resolveComponentTargets(kernel, target);
      const selection: SelectionEntry[] = targets.map((entry) => ({ kind: "component", id: entry.id }));
      kernel.store.getState().actions.select(selection, Boolean(options?.additive));
      return selection;
    },
    enable(target: TargetInput) {
      assertWritable(kernel);
      const targets = resolveComponentTargets(kernel, target);
      for (const entry of targets) {
        kernel.store.getState().actions.setNodeEnabled({ kind: "component", id: entry.id }, true);
      }
      return { enabled: targets.length };
    },
    disable(target: TargetInput) {
      assertWritable(kernel);
      const targets = resolveComponentTargets(kernel, target);
      for (const entry of targets) {
        kernel.store.getState().actions.setNodeEnabled({ kind: "component", id: entry.id }, false);
      }
      return { disabled: targets.length };
    },
    params: {
      get(target: TargetInput, key?: string) {
        const targets = resolveComponentTargets(kernel, target);
        return targets.map((entry) => ({
          componentId: entry.id,
          name: entry.name,
          params: key ? entry.params[key] : entry.params
        }));
      },
      set(target: TargetInput, patch: Record<string, unknown>) {
        assertWritable(kernel);
        const targets = resolveComponentTargets(kernel, target);
        for (const entry of targets) {
          kernel.store.getState().actions.updateComponentParams(entry.id, patch as ParameterValues);
        }
        return { updated: targets.length };
      }
    }
  };

  return {
    help: () => buildHelp(),
    scene,
    actor,
    component,
    project: {
      async list() {
        const recents = await kernel.projectService.loadRecents();
        return recents.map((entry) => entry.cachedName);
      },
      status() {
        const state = kernel.store.getState().state;
        return {
          mode: state.mode,
          activeProjectName: state.activeProject?.name ?? "",
          activeProjectPath: state.activeProject?.path ?? null,
          activeProjectUuid: state.activeProject?.uuid ?? null,
          activeSnapshotName: state.activeSnapshotName,
          dirty: state.dirty,
          actorCount: Object.keys(state.actors).length
        };
      },
      async new(name: string) {
        assertWritable(kernel);
        await kernel.projectService.createNewProject({ projectName: name });
        return {
          activeProjectName: kernel.store.getState().state.activeProject?.name ?? "",
          activeSnapshotName: kernel.store.getState().state.activeSnapshotName
        };
      },
      async open(simularcaPath: string, snapshot: string | null = null) {
        await kernel.projectService.openProject(simularcaPath, snapshot);
        return {
          activeProjectName: kernel.store.getState().state.activeProject?.name ?? "",
          activeSnapshotName: kernel.store.getState().state.activeSnapshotName
        };
      },
      async reload() {
        await kernel.projectService.loadSnapshot(kernel.store.getState().state.activeSnapshotName);
        return {
          activeProjectName: kernel.store.getState().state.activeProject?.name ?? "",
          activeSnapshotName: kernel.store.getState().state.activeSnapshotName
        };
      },
      async save() {
        assertWritable(kernel);
        await kernel.projectService.saveProject();
        return { saved: true };
      },
      async rename(nextName: string) {
        assertWritable(kernel);
        await kernel.projectService.renameProject(nextName);
        return {
          activeProjectName: kernel.store.getState().state.activeProject?.name ?? "",
          activeSnapshotName: kernel.store.getState().state.activeSnapshotName
        };
      },
      snapshots: {
        list() {
          return kernel.projectService.listSnapshots();
        },
        async saveAs(name: string) {
          assertWritable(kernel);
          await kernel.projectService.saveSnapshotAs(name);
          return { activeSnapshotName: kernel.store.getState().state.activeSnapshotName };
        },
        async rename(nextName: string) {
          assertWritable(kernel);
          const current = kernel.store.getState().state.activeSnapshotName;
          await kernel.projectService.renameSnapshot(current, nextName);
          return { activeSnapshotName: kernel.store.getState().state.activeSnapshotName };
        },
        async duplicate(name: string) {
          assertWritable(kernel);
          const current = kernel.store.getState().state.activeSnapshotName;
          await kernel.projectService.duplicateSnapshot(current, name);
          return { duplicated: name };
        },
        async delete(name?: string) {
          assertWritable(kernel);
          await kernel.projectService.deleteSnapshot(name ?? kernel.store.getState().state.activeSnapshotName);
          return { activeSnapshotName: kernel.store.getState().state.activeSnapshotName };
        }
      }
    },
    time: {
      play() {
        kernel.store.getState().actions.setTimeRunning(true);
        return { running: true };
      },
      pause() {
        kernel.store.getState().actions.setTimeRunning(false);
        return { running: false };
      },
      toggle() {
        const running = kernel.store.getState().state.time.running;
        kernel.store.getState().actions.setTimeRunning(!running);
        return { running: !running };
      },
      step(frames = 1) {
        const safe = Math.max(1, Math.floor(Number(frames) || 1));
        for (let index = 0; index < safe; index += 1) {
          kernel.store.getState().actions.stepTime(1);
        }
        return { stepped: safe };
      },
      speed(value: 0.125 | 0.25 | 0.5 | 1 | 2 | 4) {
        kernel.store.getState().actions.setTimeSpeed(value);
        return { speed: value };
      }
    },
    camera: {
      preset(name: "perspective" | "isometric" | "top" | "left" | "front" | "back") {
        kernel.store.getState().actions.applyCameraPreset(name);
        return kernel.store.getState().state.camera;
      },
      state() {
        return kernel.store.getState().state.camera;
      },
      debug() {
        return buildCameraDebug(kernel);
      }
    },
    app: {
      undo() {
        kernel.store.getState().actions.undo();
        return { ok: true };
      },
      redo() {
        kernel.store.getState().actions.redo();
        return { ok: true };
      }
    },
    window: {
      async state() {
        if (!window.electronAPI) {
          return { isDesktop: false, isMaximized: false, isFullscreen: false };
        }
        return {
          isDesktop: true,
          ...(await window.electronAPI.getWindowState())
        };
      },
      async minimize() {
        if (!window.electronAPI) {
          throw new Error("Window controls are only available in desktop mode.");
        }
        await window.electronAPI.windowMinimize();
        return { ok: true };
      },
      async maximize() {
        if (!window.electronAPI) {
          throw new Error("Window controls are only available in desktop mode.");
        }
        await window.electronAPI.windowToggleMaximize();
        return await window.electronAPI.getWindowState();
      },
      async close(options?: { confirm?: boolean }) {
        if (!options?.confirm) {
          throw new Error("window.close requires { confirm: true }.");
        }
        if (!window.electronAPI) {
          throw new Error("Window controls are only available in desktop mode.");
        }
        await window.electronAPI.windowClose();
        return { ok: true };
      }
    },
    plugin: {
      list() {
        return kernel.pluginApi.listPlugins().map((entry) => ({
          id: entry.definition.id,
          name: entry.manifest?.name ?? entry.definition.name,
          version: entry.manifest?.version ?? "unknown"
        }));
      },
      async load(modulePath: string) {
        const loaded = await loadPluginFromModule(kernel, modulePath);
        return {
          id: loaded.plugin.id,
          name: loaded.manifest.name,
          version: loaded.manifest.version
        };
      }
    }
  };
}

function getAsyncFunctionConstructor(): new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown> {
  return Object.getPrototypeOf(async function () {
    return;
  }).constructor as new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;
}

function getValidScopeBindingNames(extraScope: Record<string, unknown>): string[] {
  return Object.keys(extraScope).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key));
}

async function evaluateSource(
  source: string,
  api: ReturnType<typeof buildRuntimeApi>,
  extraScope: Record<string, unknown>
): Promise<unknown> {
  const AsyncFunction = getAsyncFunctionConstructor();
  const bindingNames = getValidScopeBindingNames(extraScope);
  const bindingValues = bindingNames.map((name) => extraScope[name]);
  try {
    const expressionFn = new AsyncFunction(
      "api",
      ...bindingNames,
      `'use strict'; const { help, scene, actor, component, project, camera, time, app, window, plugin } = api; return await (${source});`
    );
    return await expressionFn(api, ...bindingValues);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const statementFn = new AsyncFunction(
      "api",
      ...bindingNames,
      `'use strict'; const { help, scene, actor, component, project, camera, time, app, window, plugin } = api; return await (async () => {\n${source}\n})();`
    );
    return await statementFn(api, ...bindingValues);
  }
}

export function getConsoleMethodDocs(): ConsoleMethodDoc[] {
  return METHOD_DOCS;
}

export function getConsoleCompletions(input: string, cursor: number): { items: ConsoleCompletion[]; activeDoc?: ConsoleMethodDoc } {
  const prefix = input.slice(0, cursor);
  const tokenMatch = prefix.match(/[a-zA-Z_$][\w$.]*$/);
  const token = tokenMatch?.[0] ?? "";

  const activeCallMatch = prefix.match(/([a-zA-Z_$][\w$.]*)\s*\($/);
  const activeDoc = activeCallMatch
    ? METHOD_DOCS.find((entry) => entry.path === activeCallMatch[1] || entry.signature.startsWith(`${activeCallMatch[1]}(`))
    : undefined;

  const items = METHOD_DOCS.filter((entry) => {
    if (!token) {
      return entry.path.split(".").length <= 2;
    }
    return entry.path.startsWith(token);
  })
    .slice(0, 50)
    .map((entry) => ({
      label: entry.path,
      insertText: `${entry.path}(`,
      detail: entry.signature,
      documentation: `${entry.description}\n\nExample: ${entry.examples[0] ?? ""}`.trim()
    }));

  return { items, activeDoc };
}

export async function executeConsoleSource(kernel: AppKernel, source: string): Promise<ConsoleExecutionResult> {
  return await executeDebugSource(kernel, source);
}

export async function executeDebugSource(
  kernel: AppKernel,
  source: string,
  options: DebugExecutionOptions = {}
): Promise<ConsoleExecutionResult> {
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, summary: "No command to run.", error: "Input is empty." };
  }

  const api = buildRuntimeApi(kernel);

  try {
    const result = await evaluateSource(source, api, options.extraScope ?? {});

    return {
      ok: true,
      summary: "Command executed.",
      result,
      details: serializeResult(result)
    };
  } catch (error) {
    return {
      ok: false,
      summary: "Command failed.",
      error: toErrorMessage(error),
      details: serializeResult(error)
    };
  }
}

import type { AppKernel } from "@/app/kernel";
import type { ActorNode, ComponentNode, SelectionEntry } from "@/core/types";
import { createActorFromDescriptor, listActorCreationOptions } from "@/features/actors/actorCatalog";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";

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

const METHOD_DOCS: ConsoleMethodDoc[] = [
  { path: "help", signature: "help()", description: "List available JS console APIs.", examples: ["help()"] },
  { path: "scene.stats", signature: "scene.stats()", description: "Return scene stats.", examples: ["scene.stats()"] },
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
  { path: "component.list", signature: "component.list(filter?)", description: "List components.", examples: ["component.list()"] },
  { path: "component.select", signature: "component.select(target, options?)", description: "Select components.", examples: ["component.select('@selected')"] },
  { path: "component.enable", signature: "component.enable(target)", description: "Enable components.", examples: ["component.enable('@selected')"] },
  { path: "component.disable", signature: "component.disable(target)", description: "Disable components.", examples: ["component.disable('@selected')"] },
  { path: "component.params.get", signature: "component.params.get(target, key?)", description: "Get component params.", examples: ["component.params.get('@selected')"] },
  { path: "component.params.set", signature: "component.params.set(target, patch)", description: "Set component params.", examples: ["component.params.set('@selected', { foo: 1 })"] },
  { path: "session.list", signature: "session.list()", description: "List sessions.", examples: ["session.list()"] },
  { path: "session.status", signature: "session.status()", description: "Get current session status.", examples: ["session.status()"] },
  { path: "session.new", signature: "session.new(name)", description: "Create and load a new session.", examples: ["session.new('Sandbox')"] },
  { path: "session.load", signature: "session.load(name)", description: "Load a session.", examples: ["session.load('demo')"] },
  { path: "session.reload", signature: "session.reload()", description: "Reload active session.", examples: ["session.reload()"] },
  { path: "session.save", signature: "session.save()", description: "Save active session.", examples: ["session.save()"] },
  { path: "session.saveAs", signature: "session.saveAs(name)", description: "Save as new session name.", examples: ["session.saveAs('backup')"] },
  { path: "session.rename", signature: "session.rename(nextName)", description: "Rename active session.", examples: ["session.rename('Project A')"] },
  { path: "time.play", signature: "time.play()", description: "Start simulation.", examples: ["time.play()"] },
  { path: "time.pause", signature: "time.pause()", description: "Pause simulation.", examples: ["time.pause()"] },
  { path: "time.toggle", signature: "time.toggle()", description: "Toggle simulation.", examples: ["time.toggle()"] },
  { path: "time.step", signature: "time.step(frames?)", description: "Step simulation.", examples: ["time.step()", "time.step(5)"] },
  { path: "time.speed", signature: "time.speed(value)", description: "Set simulation speed preset.", examples: ["time.speed(2)"] },
  { path: "camera.preset", signature: "camera.preset(name)", description: "Apply camera preset.", examples: ["camera.preset('isometric')"] },
  { path: "camera.state", signature: "camera.state()", description: "Get current camera.", examples: ["camera.state()"] },
  { path: "camera.bookmarks.save", signature: "camera.bookmarks.save(name)", description: "Save bookmark.", examples: ["camera.bookmarks.save('Shot A')"] },
  { path: "camera.bookmarks.load", signature: "camera.bookmarks.load(idOrName)", description: "Load bookmark.", examples: ["camera.bookmarks.load('Shot A')"] },
  { path: "camera.bookmarks.remove", signature: "camera.bookmarks.remove(idOrName)", description: "Delete bookmark.", examples: ["camera.bookmarks.remove('Shot A')"] },
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
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
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

function findBookmarkId(kernel: AppKernel, idOrName: string): string {
  const state = kernel.store.getState().state;
  const byId = state.cameraBookmarks.find((entry) => entry.id === idOrName);
  if (byId) {
    return byId.id;
  }
  const byName = state.cameraBookmarks.filter((entry) => entry.name === idOrName);
  if (byName.length === 1) {
    const first = byName[0];
    if (first) {
      return first.id;
    }
  }
  if (byName.length > 1) {
    throw new Error(`Bookmark name '${idOrName}' is ambiguous (${byName.map((entry) => entry.id).join(", ")}).`);
  }
  throw new Error(`Bookmark not found: ${idOrName}`);
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
          kernel.store.getState().actions.updateActorParams(entry.id, patch as Record<string, number | string | boolean>);
        }
        return { updated: targets.length };
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
          kernel.store.getState().actions.updateComponentParams(entry.id, patch as Record<string, number | string | boolean>);
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
    session: {
      list() {
        return kernel.sessionService.listSessions();
      },
      status() {
        const state = kernel.store.getState().state;
        return {
          mode: state.mode,
          activeSessionName: state.activeSessionName,
          dirty: state.dirty,
          actorCount: Object.keys(state.actors).length
        };
      },
      async new(name: string) {
        assertWritable(kernel);
        await kernel.sessionService.createNewSession(name);
        return { activeSessionName: kernel.store.getState().state.activeSessionName };
      },
      async load(name: string) {
        await kernel.sessionService.loadSession(name);
        return { activeSessionName: kernel.store.getState().state.activeSessionName };
      },
      async reload() {
        await kernel.sessionService.loadSession(kernel.store.getState().state.activeSessionName);
        return { activeSessionName: kernel.store.getState().state.activeSessionName };
      },
      async save() {
        assertWritable(kernel);
        await kernel.sessionService.saveSession();
        return { saved: true };
      },
      async saveAs(name: string) {
        assertWritable(kernel);
        await kernel.sessionService.saveAs(name);
        return { activeSessionName: kernel.store.getState().state.activeSessionName };
      },
      async rename(nextName: string) {
        assertWritable(kernel);
        const current = kernel.store.getState().state.activeSessionName;
        await kernel.sessionService.renameSession(current, nextName);
        return { activeSessionName: kernel.store.getState().state.activeSessionName };
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
      bookmarks: {
        save(name: string) {
          assertWritable(kernel);
          kernel.store.getState().actions.saveCameraBookmark(name);
          return { count: kernel.store.getState().state.cameraBookmarks.length };
        },
        load(idOrName: string) {
          const id = findBookmarkId(kernel, idOrName);
          kernel.store.getState().actions.loadCameraBookmark(id);
          return kernel.store.getState().state.camera;
        },
        remove(idOrName: string) {
          assertWritable(kernel);
          const id = findBookmarkId(kernel, idOrName);
          kernel.store.getState().actions.removeCameraBookmark(id);
          return { count: kernel.store.getState().state.cameraBookmarks.length };
        }
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
          return { isDesktop: false, isMaximized: false };
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
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, summary: "No command to run.", error: "Input is empty." };
  }

  const api = buildRuntimeApi(kernel);

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {
      return;
    }).constructor as new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;
    let result: unknown;
    try {
      const expressionFn = new AsyncFunction(
        "api",
        `'use strict'; const { help, scene, actor, component, session, camera, time, app, window, plugin } = api; return await (${source});`
      );
      result = await expressionFn(api);
    } catch (error) {
      const syntaxError = error instanceof SyntaxError;
      if (!syntaxError) {
        throw error;
      }
      const statementFn = new AsyncFunction(
        "api",
        `'use strict'; const { help, scene, actor, component, session, camera, time, app, window, plugin } = api; return await (async () => {\n${source}\n})();`
      );
      result = await statementFn(api);
    }

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

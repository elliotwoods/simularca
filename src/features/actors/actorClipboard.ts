import type { AppKernel } from "@/app/kernel";
import type { ActorNode, ActorType, ComponentNode } from "@/core/types";
import {
  collectSubtreeIds,
  duplicateActorSubtrees,
  filterTopLevelRoots,
  type RefKeyResolver
} from "@/features/actors/actorDuplication";

/**
 * Copy / paste / duplicate of actors.
 *
 * These orchestrators live in `features` (not the core store) because they need
 * the live descriptor registry to know which params hold actor references — the
 * core store has no access to descriptors. They compose the schema-agnostic
 * `duplicateActorSubtrees` helper with the store's `insertDuplicatedActors`.
 *
 * Transport is the system clipboard via the Web Clipboard API (already used in
 * the renderer for migration import/export), so copies survive across separate
 * Simularca windows. No Electron IPC is required for text.
 */

const CLIPBOARD_TAG = "simularca/actors" as const;
const CLIPBOARD_VERSION = 1 as const;

interface ActorClipboardPayload {
  __simularcaClipboard: typeof CLIPBOARD_TAG;
  version: typeof CLIPBOARD_VERSION;
  actors: ActorNode[];
  components: ComponentNode[];
  rootIds: string[];
}

/**
 * Refs that point at other actors but are NOT declared as `actor-ref` in any
 * schema. Camera-path stores its own child curve ids as plain string params, so
 * without this a duplicated camera-path would keep pointing at the ORIGINAL's
 * curves. Keep this list tiny and well-justified.
 */
const STRUCTURAL_REF_KEYS: Partial<Record<ActorType, string[]>> = {
  "camera-path": ["positionCurveActorId", "targetCurveActorId"]
};

/**
 * Build a resolver mapping an actor to the param keys that hold actor
 * references, by scanning the live actor descriptor schemas. Plugin actors are
 * keyed by `pluginType` (they all share `actorType: "plugin"`); everything else
 * by `actorType`.
 */
export function buildRefKeyResolver(kernel: AppKernel): RefKeyResolver {
  interface Keys {
    refKeys: Set<string>;
    refListKeys: Set<string>;
  }
  const byActorType = new Map<string, Keys>();
  const byPluginType = new Map<string, Keys>();
  const ensure = (map: Map<string, Keys>, key: string): Keys => {
    let entry = map.get(key);
    if (!entry) {
      entry = { refKeys: new Set(), refListKeys: new Set() };
      map.set(key, entry);
    }
    return entry;
  };

  for (const descriptor of kernel.descriptorRegistry.listByKind("actor")) {
    const spawn = descriptor.spawn;
    if (!spawn) {
      continue;
    }
    const target = spawn.pluginType
      ? ensure(byPluginType, spawn.pluginType)
      : ensure(byActorType, spawn.actorType);
    for (const param of descriptor.schema.params) {
      if (param.type === "actor-ref") {
        target.refKeys.add(param.key);
      } else if (param.type === "actor-ref-list") {
        target.refListKeys.add(param.key);
      }
    }
  }

  return (actor: ActorNode) => {
    const base = actor.pluginType ? byPluginType.get(actor.pluginType) : byActorType.get(actor.actorType);
    const refKeys = new Set<string>(base?.refKeys ?? []);
    const refListKeys = new Set<string>(base?.refListKeys ?? []);
    for (const key of STRUCTURAL_REF_KEYS[actor.actorType] ?? []) {
      refKeys.add(key);
    }
    return { refKeys: [...refKeys], refListKeys: [...refListKeys] };
  };
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function selectedActorIds(kernel: AppKernel): string[] {
  return kernel.store
    .getState()
    .state.selection.filter((entry) => entry.kind === "actor")
    .map((entry) => entry.id);
}

/** Serialize the selected actors' subtrees to the system clipboard. */
export async function copySelection(kernel: AppKernel): Promise<void> {
  const state = kernel.store.getState().state;
  const { roots, actorIds, componentIds } = collectSubtreeIds(state.actors, selectedActorIds(kernel));
  if (roots.length === 0) {
    return;
  }
  const payload: ActorClipboardPayload = {
    __simularcaClipboard: CLIPBOARD_TAG,
    version: CLIPBOARD_VERSION,
    actors: actorIds.map((id) => structuredClone(state.actors[id]!)),
    components: componentIds.filter((id) => state.components[id]).map((id) => structuredClone(state.components[id]!)),
    rootIds: roots
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload));
    kernel.store.getState().actions.setStatus(`Copied ${roots.length} actor${plural(roots.length)} to clipboard.`);
  } catch (error) {
    kernel.store.getState().actions.addLog({
      level: "error",
      message: "Copy to clipboard failed.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseClipboardPayload(text: string): ActorClipboardPayload | null {
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<ActorClipboardPayload>;
  if (
    candidate.__simularcaClipboard !== CLIPBOARD_TAG ||
    candidate.version !== CLIPBOARD_VERSION ||
    !Array.isArray(candidate.actors) ||
    !Array.isArray(candidate.rootIds)
  ) {
    return null;
  }
  return {
    __simularcaClipboard: CLIPBOARD_TAG,
    version: CLIPBOARD_VERSION,
    actors: candidate.actors,
    components: Array.isArray(candidate.components) ? candidate.components : [],
    rootIds: candidate.rootIds
  };
}

/**
 * Paste actors from the system clipboard, nested under the currently-selected
 * actor (or the scene root if zero/multiple actors are selected). No-op if the
 * clipboard doesn't hold a Simularca actor payload.
 */
export async function pasteClipboard(kernel: AppKernel): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  const payload = parseClipboardPayload(text);
  if (!payload) {
    return;
  }
  const state = kernel.store.getState().state;
  const selected = state.selection.filter((entry) => entry.kind === "actor");
  const parentActorId = selected.length === 1 && state.actors[selected[0]!.id] ? selected[0]!.id : null;

  const source = {
    actors: Object.fromEntries(payload.actors.map((actor) => [actor.id, actor])),
    components: Object.fromEntries(payload.components.map((component) => [component.id, component]))
  };
  const result = duplicateActorSubtrees(source, payload.rootIds, { resolveParentId: () => parentActorId }, buildRefKeyResolver(kernel));
  const inserted = kernel.store.getState().actions.insertDuplicatedActors({
    actors: result.actors,
    components: result.components,
    newTopLevelIds: result.newTopLevelIds
  });
  if (inserted.length > 0) {
    kernel.store.getState().actions.setStatus(`Pasted ${inserted.length} actor${plural(inserted.length)}.`);
  }
}

/**
 * Duplicate the selected actors in place — each copy is a sibling of its
 * original (same parent), operating on live state without touching the
 * clipboard.
 */
export function duplicateSelection(kernel: AppKernel): void {
  const state = kernel.store.getState().state;
  const ids = selectedActorIds(kernel);
  if (filterTopLevelRoots(state.actors, ids).length === 0) {
    return;
  }
  const result = duplicateActorSubtrees(
    { actors: state.actors, components: state.components },
    ids,
    { resolveParentId: (original) => original.parentActorId },
    buildRefKeyResolver(kernel)
  );
  const inserted = kernel.store.getState().actions.insertDuplicatedActors({
    actors: result.actors,
    components: result.components,
    newTopLevelIds: result.newTopLevelIds
  });
  if (inserted.length > 0) {
    kernel.store.getState().actions.setStatus(`Duplicated ${inserted.length} actor${plural(inserted.length)}.`);
  }
}

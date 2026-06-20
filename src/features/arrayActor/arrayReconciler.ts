import * as THREE from "three";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, AppState, ComponentNode } from "@/core/types";
import { duplicateActorSubtrees, type RefKeyResolver } from "@/features/actors/actorDuplication";
import { buildRefKeyResolver } from "@/features/actors/actorClipboard";
import { resolveActorWorldMatrix, sampleCurveWorldPoint } from "@/features/cameraPath/model";
import {
  composeInstanceTransform,
  computePlacements,
  readArrayParams,
  type ArrayParams,
  type LocalCurveSampler
} from "@/features/arrayActor/arrayPattern";

/**
 * Kernel-owned controller that materialises an Array actor's authored child
 * subtree(s) into many real, flagged "generated" instance actors arranged by
 * the array's pattern. Lives outside the renderer (there are two — WebGL and
 * WebGPU — each with its own SceneController) so generated actors are written to
 * the store exactly once, then rendered/synced by whichever controller is live.
 *
 * Because each instance is a real actor, per-frame, per-instance behaviour
 * (e.g. a Source Four fixture aiming at a target) "just works": the clone keeps
 * its external actor-ref to the shared target, while refs pointing INSIDE the
 * cloned subtree are remapped to that instance's own copy by
 * {@link duplicateActorSubtrees}.
 */
const MAX_PASSES = 8;

export class ArrayReconciler {
  private unsubscribe: (() => void) | null = null;
  private applying = false;
  private readonly signatures = new Map<string, string>();

  constructor(private readonly kernel: AppKernel) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.kernel.store.subscribe((curr, prev) => {
      if (this.applying) {
        return;
      }
      if (curr.state.actors === prev.state.actors && curr.state.scene === prev.state.scene) {
        return;
      }
      this.reconcileAll();
    });
    this.reconcileAll();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private reconcileAll(): void {
    if (this.applying) {
      return;
    }
    this.applying = true;
    try {
      const refKeysFor = buildRefKeyResolver(this.kernel);
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const state = this.kernel.store.getState().state;
        const arrays = Object.values(state.actors).filter((actor) => actor.actorType === "array");
        const liveIds = new Set(arrays.map((actor) => actor.id));
        for (const id of [...this.signatures.keys()]) {
          if (!liveIds.has(id)) {
            this.signatures.delete(id);
          }
        }
        let changed = false;
        for (const arrayActor of arrays) {
          if (this.reconcileArray(arrayActor.id, refKeysFor)) {
            changed = true;
          }
        }
        if (!changed) {
          break;
        }
      }
    } finally {
      this.applying = false;
    }
  }

  /** Reconcile a single array actor. Returns true if the store was mutated. */
  private reconcileArray(arrayId: string, refKeysFor: RefKeyResolver): boolean {
    const state = this.kernel.store.getState().state;
    const arrayActor = state.actors[arrayId];
    if (!arrayActor || arrayActor.actorType !== "array") {
      return false;
    }
    const params = readArrayParams(arrayActor.params);
    // The cloning view keeps authored actors plus generated actors owned by an
    // ANCESTOR array (the template skeleton of a nested array), while dropping
    // this array's own instances and any deeper-owned generated content.
    const ancestorOwners = ancestorIds(state.actors, arrayId);
    const cloningView = buildCloningView(state.actors, ancestorOwners);
    const templateRootIds = arrayActor.childActorIds.filter((id) => Boolean(cloningView[id]));
    const signature = this.computeSignature(state, arrayActor, params, cloningView, templateRootIds);
    if (this.signatures.get(arrayId) === signature) {
      return false;
    }

    const removeRootIds = arrayActor.childActorIds.filter(
      (id) => state.actors[id]?.generatedByActorId === arrayId
    );

    const addActors: ActorNode[] = [];
    const addComponents: ComponentNode[] = [];
    const addRootIds: string[] = [];

    if (templateRootIds.length > 0) {
      const sampler = this.buildCurveSampler(state, arrayActor, params);
      const placements = computePlacements(params, sampler);
      for (const placement of placements) {
        const result = duplicateActorSubtrees(
          { actors: cloningView, components: state.components },
          templateRootIds,
          { resolveParentId: () => arrayId },
          refKeysFor
        );
        const byId = new Map(result.actors.map((actor) => [actor.id, actor] as const));
        for (const actor of result.actors) {
          actor.generatedByActorId = arrayId;
        }
        // newTopLevelIds[k] corresponds to templateRootIds[k] (filterTopLevelRoots
        // preserves order, and the array's direct children are mutual siblings).
        result.newTopLevelIds.forEach((newRootId, index) => {
          const original = state.actors[templateRootIds[index]!];
          const cloneRoot = byId.get(newRootId);
          if (original && cloneRoot) {
            cloneRoot.transform = composeInstanceTransform(placement, original.transform);
          }
        });
        addActors.push(...result.actors);
        addComponents.push(...result.components);
        addRootIds.push(...result.newTopLevelIds);
      }
    }

    this.signatures.set(arrayId, signature);
    const didMutate = removeRootIds.length > 0 || addActors.length > 0;
    if (didMutate) {
      this.kernel.store.getState().actions.applyGeneratedActorDiff({
        removeRootIds,
        addActors,
        addComponents,
        addRootIds
      });
    }
    return didMutate;
  }

  private buildCurveSampler(state: AppState, arrayActor: ActorNode, params: ArrayParams): LocalCurveSampler | undefined {
    if (params.pattern !== "along-curve") {
      return undefined;
    }
    const curve = state.actors[params.curveActorId];
    if (!curve || curve.actorType !== "curve") {
      return undefined;
    }
    // Cycle guard: a curve living inside the array's own subtree would recurse.
    if (isDescendantOrSelf(state.actors, curve.id, arrayActor.id)) {
      return undefined;
    }
    const arrayWorldInverse = resolveActorWorldMatrix(arrayActor.id, state.actors).clone().invert();
    const normalMatrix = new THREE.Matrix3().setFromMatrix4(arrayWorldInverse);
    return (t: number) => {
      const world = sampleCurveWorldPoint(curve, state.actors, t);
      const position = new THREE.Vector3(...world.position).applyMatrix4(arrayWorldInverse);
      const tangent = new THREE.Vector3(...world.tangent).applyMatrix3(normalMatrix).normalize();
      return {
        position: [position.x, position.y, position.z],
        tangent: [tangent.x, tangent.y, tangent.z]
      };
    };
  }

  private computeSignature(
    state: AppState,
    arrayActor: ActorNode,
    params: ArrayParams,
    cloningView: Record<string, ActorNode>,
    templateRootIds: string[]
  ): string {
    const subtree: unknown[] = [];
    const visit = (id: string): void => {
      const actor = cloningView[id];
      if (!actor) {
        return;
      }
      subtree.push({
        id,
        parent: actor.parentActorId,
        type: actor.actorType,
        pluginType: actor.pluginType,
        owner: actor.generatedByActorId ?? null,
        transform: actor.transform,
        params: actor.params,
        children: actor.childActorIds,
        components: actor.componentIds.map((componentId) => state.components[componentId]?.params ?? null)
      });
      for (const childId of actor.childActorIds) {
        visit(childId);
      }
    };
    for (const rootId of templateRootIds) {
      visit(rootId);
    }

    const parts: Record<string, unknown> = { params: arrayActor.params, subtree };
    if (params.pattern === "along-curve") {
      parts.arrayWorld = resolveActorWorldMatrix(arrayActor.id, state.actors).elements;
      const curve = state.actors[params.curveActorId];
      parts.curve = curve
        ? { params: curve.params, world: resolveActorWorldMatrix(curve.id, state.actors).elements }
        : null;
    }
    return JSON.stringify(parts);
  }
}

/** The ids of every strict ancestor of `actorId`, walking the parent chain. */
function ancestorIds(actors: Record<string, ActorNode>, actorId: string): Set<string> {
  const ids = new Set<string>();
  let cursor = actors[actorId]?.parentActorId ?? null;
  while (cursor && !ids.has(cursor)) {
    ids.add(cursor);
    cursor = actors[cursor]?.parentActorId ?? null;
  }
  return ids;
}

/**
 * Build the actor view used to clone an array's template. Keeps authored actors
 * and generated actors owned by an ancestor array (so a nested array can clone
 * its template, which is itself a clone owned by the outer array), while
 * dropping the array's own instances and any deeper-owned generated content.
 * Each kept actor's `childActorIds` is pruned to other kept actors.
 */
function buildCloningView(
  actors: Record<string, ActorNode>,
  ancestorOwners: Set<string>
): Record<string, ActorNode> {
  const keep = (actor: ActorNode | undefined): boolean =>
    Boolean(actor) && (!actor!.generatedByActorId || ancestorOwners.has(actor!.generatedByActorId));
  const view: Record<string, ActorNode> = {};
  for (const [id, actor] of Object.entries(actors)) {
    if (!keep(actor)) {
      continue;
    }
    view[id] = {
      ...actor,
      childActorIds: actor.childActorIds.filter((childId) => keep(actors[childId]))
    };
  }
  return view;
}

function isDescendantOrSelf(actors: Record<string, ActorNode>, id: string, ancestorId: string): boolean {
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor) {
    if (cursor === ancestorId) {
      return true;
    }
    if (guard.has(cursor)) {
      break;
    }
    guard.add(cursor);
    cursor = actors[cursor]?.parentActorId ?? null;
  }
  return false;
}

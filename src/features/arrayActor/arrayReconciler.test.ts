import { describe, expect, it } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import type { ActorNode, AppState } from "@/core/types";
import { arrayActorDescriptor } from "@/features/actors/descriptors/arrayActor";
import { mistVolumeActorDescriptor } from "@/features/actors/descriptors/mistVolumeActor";
import { ArrayReconciler } from "@/features/arrayActor/arrayReconciler";
import { buildProjectSnapshotManifest } from "@/core/project/projectSnapshotManifest";
import { isHiddenArrayTemplate } from "@/render/sceneController";
import { ActorProfilingService } from "@/render/profiling";

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: { listPlugins: () => [] } as unknown as AppKernel["pluginApi"],
    descriptorRegistry: {
      listByKind: () => [arrayActorDescriptor, mistVolumeActorDescriptor]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

function state(kernel: AppKernel): AppState {
  return kernel.store.getState().state;
}

function generatedRoots(kernel: AppKernel, arrayId: string): ActorNode[] {
  const s = state(kernel);
  const array = s.actors[arrayId]!;
  return array.childActorIds.map((id) => s.actors[id]!).filter((actor) => actor.generatedByActorId === arrayId);
}

function allGenerated(kernel: AppKernel): ActorNode[] {
  return Object.values(state(kernel).actors).filter((actor) => actor.generatedByActorId);
}

function makeLinearArray(kernel: AppKernel, count: number): string {
  const actions = kernel.store.getState().actions;
  const arrayId = actions.createActor({ actorType: "array", name: "Array" });
  actions.updateActorParams(arrayId, {
    pattern: "linear",
    linearCount: count,
    linearExtent: [3, 0, 0],
    linearCentered: true
  });
  return arrayId;
}

describe("ArrayReconciler — shared vs copied target", () => {
  it("keeps an external target ref shared across every instance", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 3);
    const targetId = actions.createActor({ actorType: "primitive", name: "Target" });
    const mistId = actions.createActorNoHistory({ actorType: "mist-volume", name: "Mist", parentActorId: arrayId });
    actions.updateActorParams(mistId, { volumeActorId: targetId });

    new ArrayReconciler(kernel).start();

    const roots = generatedRoots(kernel, arrayId);
    expect(roots).toHaveLength(3);
    for (const root of roots) {
      expect(root.actorType).toBe("mist-volume");
      expect(root.params.volumeActorId).toBe(targetId);
    }
    const xs = roots.map((r) => r.transform.position[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1.5, 5);
    expect(xs[1]).toBeCloseTo(0, 5);
    expect(xs[2]).toBeCloseTo(1.5, 5);
  });

  it("copies an internal target ref per instance", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 3);
    const targetId = actions.createActorNoHistory({ actorType: "primitive", name: "T", parentActorId: arrayId });
    const mistId = actions.createActorNoHistory({ actorType: "mist-volume", name: "Mist", parentActorId: arrayId });
    actions.updateActorParams(mistId, { volumeActorId: targetId });

    new ArrayReconciler(kernel).start();

    const s = state(kernel);
    const mistRoots = generatedRoots(kernel, arrayId).filter((r) => r.actorType === "mist-volume");
    expect(mistRoots).toHaveLength(3);
    const referenced = new Set<string>();
    for (const mist of mistRoots) {
      const ref = mist.params.volumeActorId as string;
      expect(ref).not.toBe(targetId);
      const target = s.actors[ref];
      expect(target?.actorType).toBe("primitive");
      expect(target?.generatedByActorId).toBe(arrayId);
      referenced.add(ref);
    }
    expect(referenced.size).toBe(3); // each instance has its own copied target
  });
});

describe("ArrayReconciler — lifecycle", () => {
  it("flags every actor of an instance subtree as generated", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 2);
    const targetId = actions.createActorNoHistory({ actorType: "primitive", name: "T", parentActorId: arrayId });
    const mistId = actions.createActorNoHistory({ actorType: "mist-volume", name: "Mist", parentActorId: arrayId });
    actions.updateActorParams(mistId, { volumeActorId: targetId });

    new ArrayReconciler(kernel).start();

    // 2 instances * 2 authored template roots = 4 generated actors.
    expect(allGenerated(kernel)).toHaveLength(4);
    for (const actor of allGenerated(kernel)) {
      expect(actor.generatedByActorId).toBe(arrayId);
    }
  });

  it("regenerates when the count changes (subscription is live)", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 3);
    actions.createActorNoHistory({ actorType: "empty", name: "Leaf", parentActorId: arrayId });

    new ArrayReconciler(kernel).start();
    expect(generatedRoots(kernel, arrayId)).toHaveLength(3);

    actions.updateActorParams(arrayId, { pattern: "linear", linearCount: 2, linearExtent: [3, 0, 0], linearCentered: true });
    expect(generatedRoots(kernel, arrayId)).toHaveLength(2);
  });

  it("produces nothing for an empty template", () => {
    const kernel = createKernelStub();
    makeLinearArray(kernel, 5);
    new ArrayReconciler(kernel).start();
    expect(allGenerated(kernel)).toHaveLength(0);
  });

  it("does not churn when nothing relevant changed", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 3);
    actions.createActorNoHistory({ actorType: "empty", name: "Leaf", parentActorId: arrayId });
    new ArrayReconciler(kernel).start();
    const idsBefore = generatedRoots(kernel, arrayId)
      .map((r) => r.id)
      .sort();

    // An unrelated change (selection) must not regenerate (new ids would appear).
    actions.select([{ kind: "actor", id: arrayId }]);
    const idsAfter = generatedRoots(kernel, arrayId)
      .map((r) => r.id)
      .sort();
    expect(idsAfter).toEqual(idsBefore);
  });
});

describe("ArrayReconciler — nested arrays", () => {
  it("generates inner instances and converges without unbounded growth", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const outerId = actions.createActor({ actorType: "array", name: "Outer" });
    actions.updateActorParams(outerId, { pattern: "linear", linearCount: 2, linearExtent: [4, 0, 0], linearCentered: true });
    const innerId = actions.createActorNoHistory({ actorType: "array", name: "Inner", parentActorId: outerId });
    actions.updateActorParams(innerId, { pattern: "linear", linearCount: 2, linearExtent: [1, 0, 0], linearCentered: true });
    actions.createActorNoHistory({ actorType: "empty", name: "Leaf", parentActorId: innerId });

    new ArrayReconciler(kernel).start();
    const countAfterFirst = Object.keys(state(kernel).actors).length;

    // There are generated array actors that themselves own generated children.
    const generatedArrays = allGenerated(kernel).filter((a) => a.actorType === "array");
    expect(generatedArrays.length).toBeGreaterThan(0);
    const innerInstances = generatedArrays.flatMap((arr) =>
      arr.childActorIds.map((id) => state(kernel).actors[id]!).filter((c) => c.generatedByActorId === arr.id)
    );
    expect(innerInstances.length).toBeGreaterThan(0);

    // A fresh reconcile rebuilds the same set — total actor count is stable.
    new ArrayReconciler(kernel).start();
    expect(Object.keys(state(kernel).actors).length).toBe(countAfterFirst);
  });
});

describe("generated actors are excluded from persistence", () => {
  it("strips generated instances (and their child links) from the snapshot", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const arrayId = makeLinearArray(kernel, 3);
    actions.createActorNoHistory({ actorType: "empty", name: "Leaf", parentActorId: arrayId });
    new ArrayReconciler(kernel).start();
    expect(allGenerated(kernel).length).toBeGreaterThan(0);

    const manifest = buildProjectSnapshotManifest(state(kernel), "electron-rw");
    const persisted = Object.values(manifest.actors);
    expect(persisted.some((actor) => actor.generatedByActorId)).toBe(false);
    // The Array actor's persisted childActorIds reference no generated instances.
    const persistedArray = manifest.actors[arrayId]!;
    for (const childId of persistedArray.childActorIds) {
      expect(manifest.actors[childId]).toBeTruthy();
    }
  });
});

describe("isHiddenArrayTemplate", () => {
  function actor(partial: Partial<ActorNode> & Pick<ActorNode, "id">): ActorNode {
    return {
      kind: "actor",
      name: partial.id,
      enabled: true,
      actorType: "empty",
      visibilityMode: "visible",
      parentActorId: null,
      childActorIds: [],
      componentIds: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: {},
      componentType: "",
      schemaId: "",
      ...partial
    } as ActorNode;
  }

  it("hides authored template members and shows generated instances", () => {
    const arr = actor({ id: "arr", actorType: "array" });
    const template = actor({ id: "tmpl", parentActorId: "arr" });
    const instance = actor({ id: "inst", parentActorId: "arr", generatedByActorId: "arr" });
    const actors = { arr, tmpl: template, inst: instance };
    expect(isHiddenArrayTemplate(template, actors)).toBe(true);
    expect(isHiddenArrayTemplate(instance, actors)).toBe(false);
    expect(isHiddenArrayTemplate(arr, actors)).toBe(false);
  });

  it("hides instances of a nested array that lives inside an outer template", () => {
    const outer = actor({ id: "outer", actorType: "array" });
    const innerTemplate = actor({ id: "inner", actorType: "array", parentActorId: "outer" });
    const innerInstance = actor({ id: "leaf", parentActorId: "inner", generatedByActorId: "inner" });
    const actors = { outer, inner: innerTemplate, leaf: innerInstance };
    // leaf is a real instance of `inner`, but `inner` is `outer`'s template → hidden.
    expect(isHiddenArrayTemplate(innerInstance, actors)).toBe(true);
  });
});

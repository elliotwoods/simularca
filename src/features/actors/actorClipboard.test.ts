import { beforeEach, describe, expect, it } from "vitest";
import type { AppKernel } from "@/app/kernel";
import { createAppStore } from "@/core/store/appStore";
import type { ActorNode } from "@/core/types";
import { cameraPathActorDescriptor } from "@/features/actors/descriptors/cameraPathActor";
import { mistVolumeActorDescriptor } from "@/features/actors/descriptors/mistVolumeActor";
import { ActorProfilingService } from "@/render/profiling";
import { copySelection, duplicateSelection, pasteClipboard } from "@/features/actors/actorClipboard";

const fakeClipboard = { text: "" };

beforeEach(() => {
  fakeClipboard.text = "";
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        fakeClipboard.text = text;
      },
      readText: async () => fakeClipboard.text
    }
  });
});

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    pluginApi: { listPlugins: () => [] } as unknown as AppKernel["pluginApi"],
    descriptorRegistry: {
      // The clipboard only needs descriptors that declare actor-ref params.
      listByKind: () => [cameraPathActorDescriptor, mistVolumeActorDescriptor]
    } as unknown as AppKernel["descriptorRegistry"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

function select(kernel: AppKernel, ...ids: string[]): void {
  kernel.store.getState().actions.select(ids.map((id) => ({ kind: "actor" as const, id })));
}

function actorCount(kernel: AppKernel): number {
  return Object.keys(kernel.store.getState().state.actors).length;
}

function selectedActors(kernel: AppKernel): ActorNode[] {
  const state = kernel.store.getState().state;
  return state.selection.filter((e) => e.kind === "actor").map((e) => state.actors[e.id]!);
}

describe("duplicateSelection", () => {
  it("duplicates a root actor as a sibling with a deduped name", () => {
    const kernel = createKernelStub();
    const id = kernel.store.getState().actions.createActor({ actorType: "empty", name: "Box" });
    select(kernel, id);
    const before = actorCount(kernel);

    duplicateSelection(kernel);

    expect(actorCount(kernel)).toBe(before + 1);
    const dups = selectedActors(kernel);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.id).not.toBe(id);
    expect(dups[0]!.name).toBe("Box2");
    expect(dups[0]!.parentActorId).toBe(null);
  });

  it("keeps a duplicated child under its original parent", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const parentId = actions.createActor({ actorType: "empty", name: "Parent" });
    const childId = actions.createActor({ actorType: "empty", name: "Child", parentActorId: parentId });
    select(kernel, childId);

    duplicateSelection(kernel);

    const dup = selectedActors(kernel)[0]!;
    expect(dup.parentActorId).toBe(parentId);
    expect(kernel.store.getState().state.actors[parentId]?.childActorIds).toHaveLength(2);
  });

  it("duplicates a parent+child selection exactly once", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const parentId = actions.createActor({ actorType: "empty", name: "P" });
    const childId = actions.createActor({ actorType: "empty", name: "C", parentActorId: parentId });
    select(kernel, parentId, childId);
    const before = actorCount(kernel);

    duplicateSelection(kernel);

    expect(actorCount(kernel)).toBe(before + 2);
    const roots = selectedActors(kernel);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.childActorIds).toHaveLength(1);
  });

  it("rewires camera-path curve id params to the duplicated children", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const camId = actions.createActor({ actorType: "camera-path", name: "Cam" });
    const posId = actions.createActorNoHistory({ actorType: "curve", name: "pos", parentActorId: camId });
    const tgtId = actions.createActorNoHistory({ actorType: "curve", name: "tgt", parentActorId: camId });
    actions.updateActorParams(camId, {
      positionCurveActorId: posId,
      targetCurveActorId: tgtId,
      targetMode: "curve",
      targetActorId: ""
    });
    select(kernel, camId);

    duplicateSelection(kernel);

    const dupCam = selectedActors(kernel)[0]!;
    expect(dupCam.childActorIds).toHaveLength(2);
    expect(dupCam.params.positionCurveActorId).not.toBe(posId);
    expect(dupCam.params.targetCurveActorId).not.toBe(tgtId);
    expect(dupCam.childActorIds).toContain(dupCam.params.positionCurveActorId);
    expect(dupCam.childActorIds).toContain(dupCam.params.targetCurveActorId);
  });

  it("rewires an actor-ref to the copy when the referenced actor is duplicated too", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const cubeId = actions.createActor({ actorType: "primitive", name: "Cube" });
    const mistId = actions.createActor({ actorType: "mist-volume", name: "Mist" });
    actions.updateActorParams(mistId, { volumeActorId: cubeId, sourceActorIds: [cubeId] });
    select(kernel, cubeId, mistId);

    duplicateSelection(kernel);

    const roots = selectedActors(kernel);
    expect(roots).toHaveLength(2);
    const dupCube = roots.find((a) => a.actorType === "primitive")!;
    const dupMist = roots.find((a) => a.actorType === "mist-volume")!;
    expect(dupMist.params.volumeActorId).toBe(dupCube.id);
    expect(dupMist.params.volumeActorId).not.toBe(cubeId);
    expect(dupMist.params.sourceActorIds).toEqual([dupCube.id]);
  });

  it("leaves an actor-ref pointing at the original when the target is not duplicated", () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const cubeId = actions.createActor({ actorType: "primitive", name: "Cube" });
    const mistId = actions.createActor({ actorType: "mist-volume", name: "Mist" });
    actions.updateActorParams(mistId, { volumeActorId: cubeId });
    select(kernel, mistId);

    duplicateSelection(kernel);

    const dupMist = selectedActors(kernel)[0]!;
    expect(dupMist.params.volumeActorId).toBe(cubeId);
  });
});

describe("copy and paste", () => {
  it("copies then pastes under the selected actor", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const srcId = actions.createActor({ actorType: "empty", name: "Src" });
    select(kernel, srcId);
    await copySelection(kernel);

    const targetId = actions.createActor({ actorType: "empty", name: "Target" });
    select(kernel, targetId);
    await pasteClipboard(kernel);

    const pasted = selectedActors(kernel)[0]!;
    expect(pasted.parentActorId).toBe(targetId);
    expect(kernel.store.getState().state.actors[targetId]?.childActorIds).toContain(pasted.id);
  });

  it("pastes to the scene root when nothing is selected", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const srcId = actions.createActor({ actorType: "empty", name: "Src" });
    select(kernel, srcId);
    await copySelection(kernel);

    actions.clearSelection();
    await pasteClipboard(kernel);

    const pasted = selectedActors(kernel)[0]!;
    expect(pasted.parentActorId).toBe(null);
    expect(kernel.store.getState().state.scene.actorIds).toContain(pasted.id);
  });

  it("produces two distinct copies across repeated pastes", async () => {
    const kernel = createKernelStub();
    const actions = kernel.store.getState().actions;
    const srcId = actions.createActor({ actorType: "empty", name: "Widget" });
    select(kernel, srcId);
    await copySelection(kernel);

    actions.clearSelection();
    await pasteClipboard(kernel);
    const first = selectedActors(kernel)[0]!.id;

    actions.clearSelection();
    await pasteClipboard(kernel);
    const second = selectedActors(kernel)[0]!.id;

    expect(first).not.toBe(second);
    expect(first).not.toBe(srcId);
    expect(kernel.store.getState().state.actors[first]).toBeTruthy();
    expect(kernel.store.getState().state.actors[second]).toBeTruthy();
  });

  it("is a no-op when the clipboard does not hold an actor payload", async () => {
    const kernel = createKernelStub();
    const before = actorCount(kernel);

    fakeClipboard.text = "not json at all";
    await pasteClipboard(kernel);
    expect(actorCount(kernel)).toBe(before);

    fakeClipboard.text = JSON.stringify({ hello: "world" });
    await pasteClipboard(kernel);
    expect(actorCount(kernel)).toBe(before);
  });
});

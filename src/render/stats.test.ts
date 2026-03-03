import { describe, expect, it } from "vitest";
import { countActorStats, summarizeMemory } from "@/render/stats";
import { createInitialState } from "@/core/defaults";

describe("render stats helpers", () => {
  it("summarizes memory with and without heap readings", () => {
    const withHeap = summarizeMemory(20 * 1024 * 1024, 30 * 1024 * 1024);
    expect(withHeap.heapMb).toBeCloseTo(20, 3);
    expect(withHeap.resourceMb).toBeCloseTo(30, 3);
    expect(withHeap.memoryMb).toBeCloseTo(50, 3);

    const withoutHeap = summarizeMemory(null, 12 * 1024 * 1024);
    expect(withoutHeap.heapMb).toBe(0);
    expect(withoutHeap.memoryMb).toBeCloseTo(12, 3);
  });

  it("counts total and enabled actors", () => {
    const state = createInitialState("electron-rw");
    state.actors.a = {
      id: "a",
      name: "a",
      kind: "actor",
      actorType: "empty",
      enabled: true,
      visibilityMode: "visible",
      parentActorId: null,
      childActorIds: [],
      componentIds: [],
      pluginType: undefined,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      },
      params: {}
    };
    state.actors.b = {
      ...state.actors.a,
      id: "b",
      name: "b",
      enabled: false
    };
    const counts = countActorStats(state.actors);
    expect(counts.actorCount).toBe(2);
    expect(counts.actorCountEnabled).toBe(1);
  });
});

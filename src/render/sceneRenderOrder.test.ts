import { describe, expect, it } from "vitest";
import { collectActorRenderOrder } from "@/render/sceneRenderOrder";

describe("scene render order", () => {
  it("walks the actor tree in scene graph order", () => {
    const ordered = collectActorRenderOrder(["a", "b"], {
      a: { id: "a", childActorIds: ["a1", "a2"] },
      a1: { id: "a1", childActorIds: [] },
      a2: { id: "a2", childActorIds: ["a2i"] },
      a2i: { id: "a2i", childActorIds: [] },
      b: { id: "b", childActorIds: ["b1"] },
      b1: { id: "b1", childActorIds: [] }
    });

    expect(ordered).toEqual(["a", "a1", "a2", "a2i", "b", "b1"]);
  });

  it("ignores missing and repeated actors safely", () => {
    const ordered = collectActorRenderOrder(["a", "missing", "a"], {
      a: { id: "a", childActorIds: ["a", "b"] },
      b: { id: "b", childActorIds: [] }
    });

    expect(ordered).toEqual(["a", "b"]);
  });
});

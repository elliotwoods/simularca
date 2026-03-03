import { describe, expect, it } from "vitest";
import { createInitialState } from "@/core/defaults";
import { estimateSessionPayloadBytes } from "@/core/session/sessionSize";
import { buildSessionManifest } from "@/core/session/sessionManifest";
import { serializeSession } from "@/core/session/sessionSchema";

describe("session payload size estimator", () => {
  it("matches serialized payload byte size", () => {
    const state = createInitialState("electron-rw", "demo");
    state.actors.actor_1 = {
      id: "actor_1",
      name: "Actor 1",
      enabled: true,
      kind: "actor",
      actorType: "empty",
      parentActorId: null,
      childActorIds: [],
      componentIds: [],
      transform: {
        position: [1, 2, 3],
        rotation: [0.1, 0.2, 0.3],
        scale: [1, 1, 1]
      },
      params: {}
    };

    const estimated = estimateSessionPayloadBytes(state, "electron-rw");
    const payload = serializeSession(buildSessionManifest(state, "electron-rw"));
    const actual = new Blob([payload]).size;

    expect(estimated).toBe(actual);
  });
});

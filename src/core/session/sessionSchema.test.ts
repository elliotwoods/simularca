import { describe, expect, it } from "vitest";
import { parseSession, serializeSession } from "@/core/session/sessionSchema";
import { createInitialState } from "@/core/defaults";
import { SESSION_SCHEMA_VERSION } from "@/core/types";
import { createId } from "@/core/ids";

describe("session schema", () => {
  it("serializes and parses a session payload", () => {
    const state = createInitialState("electron-rw", "demo");
    const curveActorId = createId("actor");
    state.actors[curveActorId] = {
      id: curveActorId,
      name: "Curve",
      enabled: true,
      kind: "actor",
      actorType: "curve",
      visibilityMode: "visible",
      parentActorId: null,
      childActorIds: [],
      componentIds: [],
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      },
      params: {
        closed: false,
        samplesPerSegment: 24,
        curveData: {
          closed: false,
          points: [
            {
              position: [0, 0, 0],
              handleIn: [-0.2, 0, 0],
              handleOut: [0.2, 0, 0],
              mode: "mirrored"
            },
            {
              position: [1, 0, 0],
              handleIn: [-0.2, 0, 0],
              handleOut: [0.2, 0, 0],
              mode: "mirrored"
            }
          ]
        }
      }
    };
    state.scene.actorIds.push(curveActorId);

    const payload = serializeSession({
      schemaVersion: SESSION_SCHEMA_VERSION,
      appMode: "electron-rw",
      sessionName: state.activeSessionName,
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: state.scene,
      actors: state.actors,
      components: state.components,
      camera: state.camera,
      cameraBookmarks: state.cameraBookmarks,
      time: state.time,
      materials: state.materials,
      assets: state.assets
    });

    const parsed = parseSession(payload);
    expect(parsed.sessionName).toBe("demo");
    expect(parsed.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(parsed.actors[curveActorId]?.actorType).toBe("curve");
    expect(parsed.actors[curveActorId]?.params.curveData).toBeTruthy();
  });
});

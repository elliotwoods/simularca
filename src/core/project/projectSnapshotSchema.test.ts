import { describe, expect, it } from "vitest";
import { parseProjectSnapshot, serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import { createInitialState } from "@/core/defaults";
import { PROJECT_SCHEMA_VERSION } from "@/core/types";
import { createId } from "@/core/ids";

describe("project snapshot schema", () => {
  it("serializes and parses a project snapshot payload", () => {
    const state = createInitialState("electron-rw", "demo", "main");
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

    const payload = serializeProjectSnapshot({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      appMode: "electron-rw",
      projectName: state.activeProjectName,
      snapshotName: state.activeSnapshotName,
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: state.scene,
      actors: state.actors,
      components: state.components,
      camera: state.camera,
      time: state.time,
      materials: state.materials,
      assets: state.assets
    });

    const parsed = parseProjectSnapshot(payload);
    expect(parsed.projectName).toBe("demo");
    expect(parsed.snapshotName).toBe("main");
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.scene.tonemapping).toEqual({
      mode: "aces",
      dither: true
    });
    expect(parsed.scene.framePacing).toEqual({
      mode: "vsync",
      targetFps: 60
    });
    expect(parsed.actors[curveActorId]?.actorType).toBe("curve");
    expect(parsed.actors[curveActorId]?.params.curveData).toBeTruthy();
  });

  it("hydrates default tonemapping settings for legacy snapshots", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION - 1,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: {
        id: "scene_legacy",
        name: "Scene",
        enabled: true,
        kind: "scene",
        actorIds: [],
        sceneComponentIds: [],
        backgroundColor: "#070b12",
        renderEngine: "webgl2",
        antialiasing: true,
        cameraKeyboardNavigation: true,
        cameraNavigationSpeed: 6
      },
      actors: {},
      components: {},
      camera: {
        mode: "perspective",
        position: [6, 4, 6],
        target: [0, 0, 0],
        fov: 50,
        zoom: 1,
        near: 0.01,
        far: 1000
      },
      time: {
        running: false,
        speed: 1,
        fixedStepSeconds: 1 / 60,
        elapsedSimSeconds: 0
      },
      materials: {},
      assets: []
    };

    const parsed = parseProjectSnapshot(JSON.stringify(payload));
    expect(parsed.scene.tonemapping).toEqual({
      mode: "aces",
      dither: true
    });
    expect(parsed.scene.framePacing).toEqual({
      mode: "vsync",
      targetFps: 60
    });
  });

  it("rejects removed native gaussian splat content with a clear error", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: createInitialState("electron-rw", "demo", "main").scene,
      actors: {
        actor_1: {
          id: "actor_1",
          name: "Legacy Splat",
          enabled: true,
          kind: "actor",
          actorType: "gaussian-splat",
          visibilityMode: "visible",
          parentActorId: null,
          childActorIds: [],
          componentIds: [],
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1]
          },
          params: {}
        }
      },
      components: {},
      camera: createInitialState("electron-rw", "demo", "main").camera,
      time: createInitialState("electron-rw", "demo", "main").time,
      materials: {},
      assets: []
    };

    expect(() => parseProjectSnapshot(JSON.stringify(payload))).toThrow(
      "This project uses the removed native Gaussian Splat system."
    );
  });
});

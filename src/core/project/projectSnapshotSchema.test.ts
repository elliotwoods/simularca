import { describe, expect, it } from "vitest";
import { parseProjectSnapshot, serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import { createInitialState, DEFAULT_SCENE_HELPERS } from "@/core/defaults";
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
      projectName: state.activeProject?.name ?? "demo",
      snapshotName: state.activeSnapshotName,
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: state.scene,
      actors: state.actors,
      components: state.components,
      camera: state.camera,
      lastPerspectiveCamera: state.lastPerspectiveCamera,
      time: state.time,
      pluginViews: {},
      pluginsEnabled: {},
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
    expect(parsed.scene.renderEngine).toBe("webgpu");
    expect(parsed.scene.colorBufferPrecision).toBe("float32");
    expect(parsed.scene.framePacing).toEqual({
      mode: "vsync",
      targetFps: 60
    });
    expect(parsed.scene.helpers).toEqual(state.scene.helpers);
    expect(parsed.scene.cameraFlyLookInvertYaw).toBe(true);
    expect(parsed.scene.cameraFlyLookSpeed).toBe(1);
    expect(parsed.actors[curveActorId]?.actorType).toBe("curve");
    expect(parsed.actors[curveActorId]?.params.curveData).toBeTruthy();
    expect(parsed.lastPerspectiveCamera).toEqual(state.lastPerspectiveCamera);
  });

  it("round-trips environment probe actors", () => {
    const state = createInitialState("electron-rw", "demo", "main");
    const probeActorId = createId("actor");
    state.actors[probeActorId] = {
      id: probeActorId,
      name: "Probe",
      enabled: true,
      kind: "actor",
      actorType: "environment-probe",
      visibilityMode: "visible",
      parentActorId: null,
      childActorIds: [],
      componentIds: [],
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      },
      params: {
        actorIds: [],
        resolution: 256,
        preview: "sphere",
        renderMode: "on-change"
      }
    };
    state.scene.actorIds.push(probeActorId);

    const payload = serializeProjectSnapshot({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      appMode: "electron-rw",
      projectName: state.activeProject?.name ?? "demo",
      snapshotName: state.activeSnapshotName,
      createdAtIso: "2026-03-31T00:00:00.000Z",
      updatedAtIso: "2026-03-31T00:00:00.000Z",
      scene: state.scene,
      actors: state.actors,
      components: state.components,
      camera: state.camera,
      lastPerspectiveCamera: state.lastPerspectiveCamera,
      time: state.time,
      pluginViews: {},
      pluginsEnabled: {},
      materials: state.materials,
      assets: state.assets
    });

    const parsed = parseProjectSnapshot(payload);
    expect(parsed.actors[probeActorId]?.actorType).toBe("environment-probe");
    expect(parsed.actors[probeActorId]?.params.preview).toBe("sphere");
    expect(parsed.actors[probeActorId]?.params.renderMode).toBe("on-change");
  });

  it("migrates legacy environment probe preview none values to sphere", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION - 1,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-31T00:00:00.000Z",
      updatedAtIso: "2026-03-31T00:00:00.000Z",
      scene: createInitialState("electron-rw", "demo", "main").scene,
      actors: {
        actor_probe: {
          id: "actor_probe",
          name: "Legacy Probe",
          enabled: true,
          kind: "actor",
          actorType: "environment-probe",
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
            actorIds: [],
            resolution: 256,
            preview: "none",
            renderMode: "on-change"
          }
        }
      },
      components: {},
      camera: createInitialState("electron-rw", "demo", "main").camera,
      lastPerspectiveCamera: createInitialState("electron-rw", "demo", "main").lastPerspectiveCamera,
      time: createInitialState("electron-rw", "demo", "main").time,
      pluginViews: {},
      materials: createInitialState("electron-rw", "demo", "main").materials,
      assets: createInitialState("electron-rw", "demo", "main").assets
    };

    const parsed = parseProjectSnapshot(JSON.stringify(payload));
    expect(parsed.actors.actor_probe?.params.preview).toBe("sphere");
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
    expect(parsed.scene.colorBufferPrecision).toBe("float32");
    expect(parsed.scene.helpers).toEqual(DEFAULT_SCENE_HELPERS);
    expect(parsed.scene.cameraFlyLookInvertYaw).toBe(true);
    expect(parsed.scene.cameraFlyLookSpeed).toBe(1);
    expect(parsed.lastPerspectiveCamera).toEqual(parsed.camera);
  });

  it("migrates legacy DXF reference actors into the DXF drawing plugin", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION - 1,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: createInitialState("electron-rw", "demo", "main").scene,
      actors: {
        actor_1: {
          id: "actor_1",
          name: "Legacy DXF",
          enabled: true,
          kind: "actor",
          actorType: "dxf-reference",
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
            assetId: "asset_1",
            inputUnits: "millimeters",
            drawingPlane: "plan-xz"
          }
        }
      },
      components: {},
      camera: createInitialState("electron-rw", "demo", "main").camera,
      time: createInitialState("electron-rw", "demo", "main").time,
      materials: {},
      assets: []
    };

    const parsed = parseProjectSnapshot(JSON.stringify(payload));
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.actors.actor_1?.actorType).toBe("plugin");
    expect(parsed.actors.actor_1?.pluginType).toBe("plugin.dxfDrawing.actor");
  });

  it("migrates legacy Spark gaussian splat actors into the merged plugin actor", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION - 1,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: createInitialState("electron-rw", "demo", "main").scene,
      actors: {
        actor_1: {
          id: "actor_1",
          name: "Legacy Spark Splat",
          enabled: true,
          kind: "actor",
          actorType: "gaussian-splat-spark",
          visibilityMode: "visible",
          parentActorId: null,
          childActorIds: [],
          componentIds: [],
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, 0],
            scale: [1, 1, 1]
          },
          params: {
            assetId: "asset_1",
            scaleFactor: 2,
            opacity: 0.5,
            brightness: 1.2,
            colorInputSpace: "iphone-sdr",
            stochasticDepth: true
          }
        }
      },
      components: {},
      camera: createInitialState("electron-rw", "demo", "main").camera,
      time: createInitialState("electron-rw", "demo", "main").time,
      materials: {},
      assets: []
    };

    const parsed = parseProjectSnapshot(JSON.stringify(payload));
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.actors.actor_1?.actorType).toBe("plugin");
    expect(parsed.actors.actor_1?.pluginType).toBe("plugin.gaussianSplat");
    expect(parsed.actors.actor_1?.params.assetId).toBe("asset_1");
    expect(parsed.actors.actor_1?.params.brightness).toBe(1.2);
    expect(parsed.actors.actor_1?.params.stochasticDepth).toBeUndefined();
  });

  it("migrates legacy WebGPU gaussian splat plugin actors into the merged plugin actor", () => {
    const payload = {
      schemaVersion: PROJECT_SCHEMA_VERSION - 1,
      appMode: "electron-rw",
      projectName: "demo",
      snapshotName: "main",
      createdAtIso: "2026-03-02T00:00:00.000Z",
      updatedAtIso: "2026-03-02T00:00:00.000Z",
      scene: createInitialState("electron-rw", "demo", "main").scene,
      actors: {
        actor_1: {
          id: "actor_1",
          name: "Legacy WebGPU Splat",
          enabled: true,
          kind: "actor",
          actorType: "plugin",
          pluginType: "plugin.gaussianSplat.webgpu",
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
            assetId: "asset_1",
            splatSizeScale: 1.5
          }
        }
      },
      components: {},
      camera: createInitialState("electron-rw", "demo", "main").camera,
      time: createInitialState("electron-rw", "demo", "main").time,
      materials: {},
      assets: []
    };

    const parsed = parseProjectSnapshot(JSON.stringify(payload));
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.actors.actor_1?.actorType).toBe("plugin");
    expect(parsed.actors.actor_1?.pluginType).toBe("plugin.gaussianSplat");
    expect(parsed.actors.actor_1?.params.splatSizeScale).toBe(1.5);
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





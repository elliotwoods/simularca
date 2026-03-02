import { createId } from "./ids";
import type { ActorNode, AppState, CameraState, SceneState, TimeState } from "./types";

export const DEFAULT_CAMERA: CameraState = {
  mode: "perspective",
  position: [6, 4, 6],
  target: [0, 0, 0],
  fov: 50,
  zoom: 1,
  near: 0.01,
  far: 1000
};

export const DEFAULT_TIME: TimeState = {
  running: false,
  speed: 1,
  fixedStepSeconds: 1 / 60,
  elapsedSimSeconds: 0
};

export function createDefaultScene(): {
  scene: SceneState;
  actors: Record<string, ActorNode>;
} {
  const scene: SceneState = {
    id: createId("scene"),
    name: "Scene",
    enabled: true,
    kind: "scene",
    actorIds: [],
    sceneComponentIds: []
  };
  return {
    scene,
    actors: {}
  };
}

export function createInitialState(mode: AppState["mode"], sessionName = "demo"): AppState {
  const defaults = createDefaultScene();
  return {
    mode,
    activeSessionName: sessionName,
    scene: defaults.scene,
    actors: defaults.actors,
    components: {},
    camera: DEFAULT_CAMERA,
    cameraBookmarks: [],
    time: DEFAULT_TIME,
    assets: [],
    selection: [],
    stats: {
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      memoryMb: 0,
      actorCount: 0,
      sessionFileBytes: 0
    },
    dirty: false,
    statusMessage: "Ready",
    consoleLogs: []
  };
}


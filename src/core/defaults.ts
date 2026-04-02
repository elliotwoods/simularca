import { createId } from "./ids";
import type {
  ActorNode,
  AppState,
  CameraState,
  Material,
  SceneColorBufferPrecision,
  SceneFramePacingSettings,
  SceneHelpersSettings,
  ScenePostProcessingSettings,
  RenderEngine,
  SceneState,
  TimeState
} from "./types";

export function createInitialMaterials(): Record<string, Material> {
  const materials: Material[] = [
    {
      id: "mat.mirror",
      name: "Mirror",
      albedo: { mode: "color", color: "#ffffff" },
      metalness: { mode: "scalar", value: 1 },
      roughness: { mode: "scalar", value: 0 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.steel",
      name: "Stainless Steel",
      albedo: { mode: "color", color: "#d1d1d1" },
      metalness: { mode: "scalar", value: 1 },
      roughness: { mode: "scalar", value: 0.1 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.wood",
      name: "Wood (Example)",
      albedo: { mode: "color", color: "#8b4513" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.8 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.stone",
      name: "Stone (Example)",
      albedo: { mode: "color", color: "#808080" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.9 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.plastic.white.glossy",
      name: "ABS Plastic White (Glossy)",
      albedo: { mode: "color", color: "#ffffff" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.1 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.plastic.white.matte",
      name: "ABS Plastic White (Matte)",
      albedo: { mode: "color", color: "#ffffff" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.6 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.paper",
      name: "Paper",
      albedo: { mode: "color", color: "#fcfcfc" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.95 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
      side: "double",
      wireframe: false
    },
    {
      id: "mat.glass",
      name: "Glass",
      albedo: { mode: "color", color: "#ffffff" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 0.2,
      transparent: true,
      side: "front",
      wireframe: false
    },
    {
      id: "mat.glass.matte",
      name: "Glass (Matte)",
      albedo: { mode: "color", color: "#ffffff" },
      metalness: { mode: "scalar", value: 0 },
      roughness: { mode: "scalar", value: 0.4 },
      normalMap: null,
      emissive: { mode: "color", color: "#000000" },
      emissiveIntensity: 0,
      opacity: 0.4,
      transparent: true,
      side: "front",
      wireframe: false
    }
  ];

  const result: Record<string, Material> = {};
  for (const mat of materials) {
    result[mat.id] = mat;
  }
  return result;
}

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
export const DEFAULT_SLOW_FRAME_DIAGNOSTICS_ENABLED = false;
export const DEFAULT_SLOW_FRAME_DIAGNOSTICS_THRESHOLD_MS = 100;
export const DEFAULT_FRAME_PACING: SceneFramePacingSettings = {
  mode: "vsync",
  targetFps: 60
};
export const DEFAULT_RENDER_ENGINE: RenderEngine = "webgpu";
export const DEFAULT_SCENE_COLOR_BUFFER_PRECISION: SceneColorBufferPrecision = "float32";
export const DEFAULT_POST_PROCESSING: ScenePostProcessingSettings = {
  bloom: {
    enabled: false,
    strength: 0.6,
    radius: 0.2,
    threshold: 0.85
  },
  vignette: {
    enabled: false,
    offset: 1,
    darkness: 0.35
  },
  chromaticAberration: {
    enabled: false,
    offset: 0.0015
  },
  grain: {
    enabled: false,
    intensity: 0.02
  }
};

export const DEFAULT_SCENE_HELPERS: SceneHelpersSettings = {
  grid: {
    visible: true,
    size: 20,
    divisions: 20,
    majorColor: "#2f8f9d",
    minorColor: "#1f2430",
    opacity: 0.35
  },
  axes: {
    visible: true,
    size: 2.5,
    xColor: "#ff0000",
    yColor: "#00ff00",
    zColor: "#0000ff",
    opacity: 1
  }
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
    sceneComponentIds: [],
    backgroundColor: "#070b12",
    renderEngine: DEFAULT_RENDER_ENGINE,
    antialiasing: true,
    colorBufferPrecision: DEFAULT_SCENE_COLOR_BUFFER_PRECISION,
    framePacing: structuredClone(DEFAULT_FRAME_PACING),
    tonemapping: {
      mode: "aces",
      dither: true
    },
    postProcessing: structuredClone(DEFAULT_POST_PROCESSING),
    helpers: structuredClone(DEFAULT_SCENE_HELPERS),
    cameraKeyboardNavigation: true,
    cameraNavigationSpeed: 6,
    cameraFlyLookInvertYaw: true,
    cameraFlyLookSpeed: 1
  };
  return {
    scene,
    actors: {}
  };
}

export function createInitialState(mode: AppState["mode"], projectName = "demo", snapshotName = "main"): AppState {
  const defaults = createDefaultScene();
  return {
    mode,
    activeProjectName: projectName,
    activeSnapshotName: snapshotName,
    scene: defaults.scene,
    actors: defaults.actors,
    components: {},
    camera: DEFAULT_CAMERA,
    lastPerspectiveCamera: DEFAULT_CAMERA,
    time: DEFAULT_TIME,
    pluginViews: {},
    focusedPluginViewId: null,
    materials: createInitialMaterials(),
    assets: [],
    selection: [],
    stats: {
      fps: 0,
      frameMs: 0,
      drawCalls: 0,
      triangles: 0,
      splatDrawCalls: 0,
      splatTriangles: 0,
      splatVisibleCount: 0,
      memoryMb: 0,
      heapMb: 0,
      resourceMb: 0,
      actorCount: 0,
      actorCountEnabled: 0,
      projectFileBytes: 0,
      projectFileBytesSaved: 0,
      cameraDistance: 0,
      cameraControlsEnabled: true,
      cameraZoomEnabled: true,
      requestedColorBufferPrecision: DEFAULT_SCENE_COLOR_BUFFER_PRECISION,
      activeColorBufferPrecision: DEFAULT_SCENE_COLOR_BUFFER_PRECISION,
      activeColorBufferFormat: "",
      requestedAntialiasing: true,
      activeAntialiasing: true,
      colorBufferWarning: ""
    },
    runtimeDebug: {
      slowFrameDiagnosticsEnabled: DEFAULT_SLOW_FRAME_DIAGNOSTICS_ENABLED,
      slowFrameDiagnosticsThresholdMs: DEFAULT_SLOW_FRAME_DIAGNOSTICS_THRESHOLD_MS
    },
    dirty: false,
    statusMessage: "Ready",
    consoleEntries: [],
    actorStatusByActorId: {}
  };
}


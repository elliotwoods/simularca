import type { AppState, CameraPreset, CameraState } from "@/core/types";
import { cameraStateForPreset } from "@/features/camera/viewUtils";

const ORTHOGRAPHIC_HALF_HEIGHT = 8;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 200;
const MIN_FOV = 5;
const MAX_FOV = 170;
const MIN_NEAR = 0.0001;

export const CAMERA_PRESET_ORDER: CameraPreset[] = ["perspective", "isometric", "top", "left", "front", "back"];

export interface CameraCycleTarget {
  id: string;
  label: string;
  camera: CameraState;
  source: "preset";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function perspectiveViewHeight(camera: CameraState): number {
  const radians = (camera.fov * Math.PI) / 180;
  const dist = Math.max(0.01, distance(camera.position, camera.target));
  return 2 * dist * Math.tan(radians * 0.5);
}

function orthographicViewHeight(camera: CameraState): number {
  const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM);
  return (ORTHOGRAPHIC_HALF_HEIGHT * 2) / zoom;
}

function viewHeight(camera: CameraState): number {
  return camera.mode === "orthographic" ? orthographicViewHeight(camera) : perspectiveViewHeight(camera);
}

function fovForViewHeight(viewHeightValue: number, distanceValue: number): number {
  const safeDistance = Math.max(0.01, distanceValue);
  const radians = 2 * Math.atan(Math.max(0.00001, viewHeightValue) / (2 * safeDistance));
  const degrees = (radians * 180) / Math.PI;
  return clamp(degrees, MIN_FOV, MAX_FOV);
}

function zoomForViewHeight(viewHeightValue: number): number {
  const safeHeight = Math.max(0.00001, viewHeightValue);
  return clamp((ORTHOGRAPHIC_HALF_HEIGHT * 2) / safeHeight, MIN_ZOOM, MAX_ZOOM);
}

export function buildCameraCycleTargets(_state: AppState): CameraCycleTarget[] {
  return CAMERA_PRESET_ORDER.map((preset) => ({
    id: `preset:${preset}`,
    label: `Preset: ${preset}`,
    camera: cameraStateForPreset(preset),
    source: "preset"
  }));
}

function cameraDistanceMetric(a: CameraState, b: CameraState): number {
  const modePenalty = a.mode === b.mode ? 0 : 0.5;
  const position = distance(a.position, b.position);
  const target = distance(a.target, b.target);
  const projection =
    a.mode === "perspective"
      ? Math.abs(a.fov - b.fov) * 0.01
      : Math.abs((a.zoom || 1) - (b.zoom || 1)) * 0.5;
  return modePenalty + position + target + projection;
}

export function findCurrentCycleIndex(currentCamera: CameraState, targets: CameraCycleTarget[]): number {
  if (targets.length === 0) {
    return -1;
  }
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < targets.length; i += 1) {
    const candidate = targets[i];
    if (!candidate) {
      continue;
    }
    const score = cameraDistanceMetric(currentCamera, candidate.camera);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function easeInOutCubic(t: number): number {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function interpolateCameraState(from: CameraState, to: CameraState, tRaw: number): CameraState {
  const t = easeInOutCubic(clamp(tRaw, 0, 1));
  const position = lerpVec3(from.position, to.position, t);
  const target = lerpVec3(from.target, to.target, t);
  const near = Math.max(MIN_NEAR, lerp(from.near, to.near, t));
  const far = Math.max(near + 0.01, lerp(from.far, to.far, t));

  const fromHeight = viewHeight(from);
  const toHeight = viewHeight(to);
  const currentHeight = lerp(fromHeight, toHeight, t);
  const currentDistance = Math.max(0.01, distance(position, target));

  const projectionMode = from.mode === to.mode ? from.mode : t < 0.5 ? from.mode : to.mode;
  const zoom = projectionMode === "orthographic" ? zoomForViewHeight(currentHeight) : 1;
  const fov = projectionMode === "perspective" ? fovForViewHeight(currentHeight, currentDistance) : to.fov;

  return {
    mode: projectionMode,
    position,
    target,
    fov,
    zoom,
    near,
    far
  };
}

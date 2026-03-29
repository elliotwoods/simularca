import * as THREE from "three";
import type { CameraState } from "@/core/types";

const POSITION_EPSILON_SQ = 1e-8;
const SCALAR_EPSILON = 1e-6;

export interface CameraStateDiff {
  modeChanged: boolean;
  positionDistanceSq: number;
  targetDistanceSq: number;
  fovDelta: number;
  zoomDelta: number;
  nearDelta: number;
  farDelta: number;
}

export function cloneCameraState(state: CameraState): CameraState {
  return {
    ...state,
    position: [...state.position] as CameraState["position"],
    target: [...state.target] as CameraState["target"]
  };
}

export function distanceSq3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function diffCameraStates(a: CameraState, b: CameraState): CameraStateDiff {
  return {
    modeChanged: a.mode !== b.mode,
    positionDistanceSq: distanceSq3(a.position, b.position),
    targetDistanceSq: distanceSq3(a.target, b.target),
    fovDelta: Math.abs(a.fov - b.fov),
    zoomDelta: Math.abs(a.zoom - b.zoom),
    nearDelta: Math.abs(a.near - b.near),
    farDelta: Math.abs(a.far - b.far)
  };
}

export function cameraStatesApproximatelyEqual(a: CameraState | null, b: CameraState | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  const diff = diffCameraStates(a, b);
  return (
    !diff.modeChanged &&
    diff.positionDistanceSq <= POSITION_EPSILON_SQ &&
    diff.targetDistanceSq <= POSITION_EPSILON_SQ &&
    diff.fovDelta <= SCALAR_EPSILON &&
    diff.zoomDelta <= SCALAR_EPSILON &&
    diff.nearDelta <= SCALAR_EPSILON &&
    diff.farDelta <= SCALAR_EPSILON
  );
}

export function readViewportCameraState(
  camera: THREE.Camera,
  target: THREE.Vector3,
  fallback: CameraState
): CameraState {
  const clippedCamera = camera as THREE.Camera & { near: number; far: number };
  return {
    mode: isOrthographicCamera(camera) ? "orthographic" : "perspective",
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [target.x, target.y, target.z],
    fov: isPerspectiveCamera(camera) ? camera.fov : fallback.fov,
    zoom: isOrthographicCamera(camera) ? camera.zoom : fallback.zoom,
    near: clippedCamera.near,
    far: clippedCamera.far
  };
}

function isPerspectiveCamera(camera: THREE.Camera): camera is THREE.PerspectiveCamera {
  return (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
}

function isOrthographicCamera(camera: THREE.Camera): camera is THREE.OrthographicCamera {
  return (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
}

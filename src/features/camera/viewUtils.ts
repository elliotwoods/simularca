import * as THREE from "three";
import type { CameraPreset, CameraState } from "@/core/types";

const ORTHOGRAPHIC_HALF_HEIGHT = 8;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 200;
const MIN_FOV = 5;
const MAX_FOV = 170;
const DEFAULT_PERSPECTIVE_DISTANCE = 9;
const HOME_CAMERA_DISTANCE = 5;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const EPSILON = 1e-6;
const ORBIT_POINTER_SCALE_BASE = Math.PI * 2;

export type CameraViewDirection = "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric";

let lastPerspectiveReference: CameraState | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toVector3(tuple: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(tuple[0], tuple[1], tuple[2]);
}

function toTuple(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function getCameraDistance(camera: CameraState): number {
  return Math.max(EPSILON, distance(camera.position, camera.target));
}

export function getCameraViewHeight(camera: CameraState): number {
  if (camera.mode === "orthographic") {
    const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM);
    return (ORTHOGRAPHIC_HALF_HEIGHT * 2) / zoom;
  }
  const radians = (camera.fov * Math.PI) / 180;
  return 2 * getCameraDistance(camera) * Math.tan(radians * 0.5);
}

function zoomForViewHeight(viewHeight: number): number {
  return clamp((ORTHOGRAPHIC_HALF_HEIGHT * 2) / Math.max(EPSILON, viewHeight), MIN_ZOOM, MAX_ZOOM);
}

function fovForViewHeight(viewHeight: number, distanceValue: number): number {
  const radians = 2 * Math.atan(Math.max(EPSILON, viewHeight) / (2 * Math.max(EPSILON, distanceValue)));
  return clamp((radians * 180) / Math.PI, MIN_FOV, MAX_FOV);
}

function directionVectorForView(direction: CameraViewDirection): THREE.Vector3 {
  switch (direction) {
    case "front":
      return new THREE.Vector3(0, 0, -1);
    case "back":
      return new THREE.Vector3(0, 0, 1);
    case "left":
      return new THREE.Vector3(1, 0, 0);
    case "right":
      return new THREE.Vector3(-1, 0, 0);
    case "top":
      return new THREE.Vector3(0, -1, 0);
    case "bottom":
      return new THREE.Vector3(0, 1, 0);
    case "isometric":
      return new THREE.Vector3(-1, -1, -1).normalize();
  }
}

export function getViewDirectionVector(direction: CameraViewDirection): THREE.Vector3 {
  return directionVectorForView(direction).clone();
}

export function getCameraForward(camera: CameraState): THREE.Vector3 {
  const forward = toVector3(camera.target).sub(toVector3(camera.position));
  if (forward.lengthSq() <= EPSILON) {
    return new THREE.Vector3(0, 0, -1);
  }
  return forward.normalize();
}

export function isCameraFacingDirection(
  camera: CameraState,
  direction: CameraViewDirection,
  toleranceDot = 0.9995
): boolean {
  const forward = getCameraForward(camera);
  return forward.dot(directionVectorForView(direction)) >= toleranceDot;
}

export function resolveRepeatedDirectionalShortcut(
  camera: CameraState,
  primaryDirection: Extract<CameraViewDirection, "front" | "right" | "top">,
  oppositeDirection: Extract<CameraViewDirection, "back" | "left" | "bottom">
): CameraViewDirection {
  return isCameraFacingDirection(camera, primaryDirection) ? oppositeDirection : primaryDirection;
}

export function cameraStateForPreset(preset: CameraPreset): CameraState {
  const base: CameraState = {
    mode: "orthographic",
    position: [6, 4, 6],
    target: [0, 0, 0],
    fov: 50,
    zoom: 1,
    near: 0.01,
    far: 1000
  };
  if (preset === "perspective") {
    return {
      ...base,
      mode: "perspective",
      position: [6, 4, 6]
    };
  }
  if (preset === "isometric") {
    return {
      ...base,
      mode: "orthographic",
      position: [8, 8, 8]
    };
  }
  if (preset === "top") {
    return { ...base, position: [0, 15, 0.001] };
  }
  if (preset === "left") {
    return { ...base, position: [-15, 0, 0] };
  }
  if (preset === "front") {
    return { ...base, position: [0, 0, 15] };
  }
  return { ...base, position: [0, 0, -15] };
}

export function cameraStateForHomeView(): CameraState {
  const homeDirection = new THREE.Vector3(1, 1, 1).normalize();
  const target = new THREE.Vector3(0, 0, 0);
  const position = target.clone().add(homeDirection.multiplyScalar(HOME_CAMERA_DISTANCE));
  const next: CameraState = {
    mode: "perspective",
    position: toTuple(position),
    target: [0, 0, 0],
    fov: 50,
    zoom: 1,
    near: 0.01,
    far: 1000
  };
  rememberPerspectiveCamera(next);
  return next;
}

export function cameraStateForViewDirection(
  current: CameraState,
  direction: CameraViewDirection,
  mode: CameraState["mode"] = "orthographic"
): CameraState {
  const forward = directionVectorForView(direction);
  const target = toVector3(current.target);
  const viewHeight = getCameraViewHeight(current);
  const perspectiveDistance =
    lastPerspectiveReference && direction !== "isometric"
      ? getCameraDistance(lastPerspectiveReference)
      : getCameraDistance(current);
  const orbitDistance = mode === "perspective" ? perspectiveDistance : getCameraDistance(current);
  const position = target.clone().sub(forward.clone().multiplyScalar(Math.max(EPSILON, orbitDistance)));
  const next: CameraState = {
    ...current,
    mode,
    position: toTuple(position),
    target: toTuple(target),
    fov: mode === "perspective" ? (lastPerspectiveReference?.fov ?? current.fov) : current.fov,
    zoom: mode === "orthographic" ? zoomForViewHeight(viewHeight) : current.zoom
  };
  if (mode === "perspective") {
    rememberPerspectiveCamera(next);
  }
  return next;
}

export function toggleCameraProjectionMode(current: CameraState): CameraState {
  const forward = getCameraForward(current);
  const target = toVector3(current.target);
  const viewHeight = getCameraViewHeight(current);
  if (current.mode === "perspective") {
    rememberPerspectiveCamera(current);
    return {
      ...current,
      mode: "orthographic",
      zoom: zoomForViewHeight(viewHeight)
    };
  }
  const reference = lastPerspectiveReference;
  const perspectiveDistance = reference ? getCameraDistance(reference) : DEFAULT_PERSPECTIVE_DISTANCE;
  const next: CameraState = {
    ...current,
    mode: "perspective",
    position: toTuple(target.clone().sub(forward.multiplyScalar(perspectiveDistance))),
    fov: reference ? reference.fov : fovForViewHeight(viewHeight, perspectiveDistance)
  };
  rememberPerspectiveCamera(next);
  return next;
}

export function stepOrbitAroundTarget(current: CameraState, yawDelta: number, pitchDelta: number): CameraState {
  const target = toVector3(current.target);
  const position = toVector3(current.position);
  const offset = position.clone().sub(target);
  if (offset.lengthSq() <= EPSILON) {
    offset.set(0, 0, DEFAULT_PERSPECTIVE_DISTANCE);
  }

  const yaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yawDelta);
  offset.applyQuaternion(yaw);

  const forward = offset.clone().multiplyScalar(-1).normalize();
  const right = new THREE.Vector3().crossVectors(forward, WORLD_UP);
  if (right.lengthSq() > EPSILON) {
    right.normalize();
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, pitchDelta);
    const pitchedOffset = offset.clone().applyQuaternion(pitch);
    const pitchedForward = pitchedOffset.clone().multiplyScalar(-1).normalize();
    if (Math.abs(pitchedForward.dot(WORLD_UP)) < 0.9995) {
      offset.copy(pitchedOffset);
    }
  }

  return {
    ...current,
    position: toTuple(target.clone().add(offset))
  };
}

export function orbitCameraFromPointerDelta(
  current: CameraState,
  deltaX: number,
  deltaY: number,
  viewportHeight: number
): CameraState {
  const safeViewportHeight = Math.max(1, viewportHeight);
  const rotationScale = ORBIT_POINTER_SCALE_BASE / safeViewportHeight;
  // Match OrbitControls: dragging right/down subtracts theta/phi.
  return stepOrbitAroundTarget(current, -deltaX * rotationScale, -deltaY * rotationScale);
}

export function flipCameraAroundTarget(current: CameraState): CameraState {
  const target = toVector3(current.target);
  const offset = target.clone().sub(toVector3(current.position));
  return {
    ...current,
    position: toTuple(target.clone().add(offset))
  };
}

export function rememberPerspectiveCamera(camera: CameraState): void {
  if (camera.mode !== "perspective") {
    return;
  }
  lastPerspectiveReference = structuredClone(camera);
}

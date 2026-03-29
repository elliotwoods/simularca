import * as THREE from "three";

const POSITION_EPSILON_SQ = 1e-8;
const QUATERNION_EPSILON = 1e-6;
const PROJECTION_EPSILON = 1e-6;
const VIEWPORT_EPSILON = 1e-3;

export interface CameraProjectionSnapshot {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  projectionMatrix: number[];
  viewport: [number, number];
}

export function captureCameraProjectionSnapshot(
  camera: THREE.Camera,
  viewportSize: THREE.Vector2
): CameraProjectionSnapshot {
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
    projectionMatrix: camera.projectionMatrix.elements.slice(),
    viewport: [viewportSize.x, viewportSize.y]
  };
}

function distanceSq3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function projectionMatricesApproximatelyEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > PROJECTION_EPSILON) {
      return false;
    }
  }
  return true;
}

export function hasCameraProjectionChanged(
  previous: CameraProjectionSnapshot | null,
  camera: THREE.Camera,
  viewportSize: THREE.Vector2
): boolean {
  if (!previous) {
    return true;
  }
  const currentPosition: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
  if (distanceSq3(previous.position, currentPosition) > POSITION_EPSILON_SQ) {
    return true;
  }
  const [qx, qy, qz, qw] = previous.quaternion;
  const quaternionDelta =
    Math.abs(qx - camera.quaternion.x) +
    Math.abs(qy - camera.quaternion.y) +
    Math.abs(qz - camera.quaternion.z) +
    Math.abs(qw - camera.quaternion.w);
  if (quaternionDelta > QUATERNION_EPSILON) {
    return true;
  }
  if (
    Math.abs(previous.viewport[0] - viewportSize.x) > VIEWPORT_EPSILON ||
    Math.abs(previous.viewport[1] - viewportSize.y) > VIEWPORT_EPSILON
  ) {
    return true;
  }
  return !projectionMatricesApproximatelyEqual(previous.projectionMatrix, camera.projectionMatrix.elements);
}

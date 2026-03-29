import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  captureCameraProjectionSnapshot,
  hasCameraProjectionChanged
} from "../../../plugins/gaussian-splat-webgpu-plugin/src/cameraInvalidation";

function makePerspectiveCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 1000);
  camera.position.set(6, 4, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function makeOrthographicCamera(): THREE.OrthographicCamera {
  const aspect = 16 / 9;
  const camera = new THREE.OrthographicCamera(-8 * aspect, 8 * aspect, 8, -8, 0.01, 1000);
  camera.position.set(6, 4, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe("gaussian splat camera invalidation", () => {
  it("does not invalidate unchanged camera and viewport state", () => {
    const camera = makePerspectiveCamera();
    const viewport = new THREE.Vector2(1920, 1080);
    const snapshot = captureCameraProjectionSnapshot(camera, viewport);

    expect(hasCameraProjectionChanged(snapshot, camera, viewport)).toBe(false);
  });

  it("invalidates on perspective dolly changes", () => {
    const camera = makePerspectiveCamera();
    const viewport = new THREE.Vector2(1920, 1080);
    const snapshot = captureCameraProjectionSnapshot(camera, viewport);

    camera.position.multiplyScalar(0.75);
    camera.updateMatrixWorld(true);

    expect(hasCameraProjectionChanged(snapshot, camera, viewport)).toBe(true);
  });

  it("invalidates on orthographic zoom changes with identical pose", () => {
    const camera = makeOrthographicCamera();
    const viewport = new THREE.Vector2(1920, 1080);
    const snapshot = captureCameraProjectionSnapshot(camera, viewport);

    camera.zoom = 2.5;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    expect(hasCameraProjectionChanged(snapshot, camera, viewport)).toBe(true);
  });

  it("invalidates when switching projection modes without moving the camera", () => {
    const perspective = makePerspectiveCamera();
    const viewport = new THREE.Vector2(1920, 1080);
    const snapshot = captureCameraProjectionSnapshot(perspective, viewport);

    const orthographic = makeOrthographicCamera();
    orthographic.position.copy(perspective.position);
    orthographic.quaternion.copy(perspective.quaternion);
    orthographic.updateMatrixWorld(true);
    orthographic.updateProjectionMatrix();

    expect(hasCameraProjectionChanged(snapshot, orthographic, viewport)).toBe(true);
  });

  it("invalidates on viewport size changes", () => {
    const camera = makePerspectiveCamera();
    const viewport = new THREE.Vector2(1920, 1080);
    const snapshot = captureCameraProjectionSnapshot(camera, viewport);

    expect(hasCameraProjectionChanged(snapshot, camera, new THREE.Vector2(1280, 720))).toBe(true);
  });
});

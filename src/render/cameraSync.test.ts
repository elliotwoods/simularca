import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { CameraState } from "@/core/types";
import {
  cameraStatesApproximatelyEqual,
  diffCameraStates,
  readViewportCameraState
} from "@/render/cameraSync";

const BASE_CAMERA: CameraState = {
  mode: "perspective",
  position: [46.63345737957947, 40.01763749654424, 19.298986511743024],
  target: [7.528669009694049, -10.227105927162894, 9.561285387215337],
  fov: 50,
  zoom: 1,
  near: 0.01,
  far: 1000
};

describe("camera sync helpers", () => {
  it("treats epsilon-scale float drift as unchanged", () => {
    const drifted: CameraState = {
      ...BASE_CAMERA,
      position: [46.63345737957948, 40.01763749654425, 19.298986511743024],
      target: [7.52866900969405, -10.227105927162896, 9.561285387215337]
    };

    expect(cameraStatesApproximatelyEqual(BASE_CAMERA, drifted)).toBe(true);
  });

  it("detects real camera movement", () => {
    const moved: CameraState = {
      ...BASE_CAMERA,
      position: [31.327840591504337, 47.831748529642404, 24.097804555894157]
    };

    expect(cameraStatesApproximatelyEqual(BASE_CAMERA, moved)).toBe(false);
    expect(diffCameraStates(BASE_CAMERA, moved).positionDistanceSq).toBeGreaterThan(1);
  });

  it("reads the live camera pose into app camera state", () => {
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    camera.position.set(3, 4, 5);
    const target = new THREE.Vector3(1, 2, 3);

    const snapshot = readViewportCameraState(camera, target, BASE_CAMERA);

    expect(snapshot).toEqual({
      mode: "perspective",
      position: [3, 4, 5],
      target: [1, 2, 3],
      fov: 42,
      zoom: 1,
      near: 0.1,
      far: 500
    });
  });
});

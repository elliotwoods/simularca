import { describe, expect, it } from "vitest";
import {
  cameraStateForHomeView,
  cameraStateForViewDirection,
  getCameraDistance,
  getCameraForward,
  getCameraViewHeight,
  orbitCameraFromPointerDelta,
  rememberPerspectiveCamera,
  resolveRepeatedDirectionalShortcut,
  stepOrbitAroundTarget,
  toggleCameraProjectionMode
} from "@/features/camera/viewUtils";
import type { CameraState } from "@/core/types";

const PERSPECTIVE_CAMERA: CameraState = {
  mode: "perspective",
  position: [6, 4, 6],
  target: [1, 2, 3],
  fov: 50,
  zoom: 1,
  near: 0.01,
  far: 1000
};

const ORTHOGRAPHIC_CAMERA: CameraState = {
  mode: "orthographic",
  position: [8, 5, 8],
  target: [1, 2, 3],
  fov: 50,
  zoom: 1.75,
  near: 0.01,
  far: 1000
};

describe("viewUtils", () => {
  it("builds the fixed isometric home camera view", () => {
    const next = cameraStateForHomeView();
    expect(next.mode).toBe("perspective");
    expect(next.target).toEqual([0, 0, 0]);
    expect(next.fov).toBe(50);
    expect(getCameraDistance(next)).toBeCloseTo(5, 5);
  });

  it("preserves target and framing when switching to an orthographic direction", () => {
    const next = cameraStateForViewDirection(PERSPECTIVE_CAMERA, "top", "orthographic");
    expect(next.target).toEqual(PERSPECTIVE_CAMERA.target);
    expect(getCameraViewHeight(next)).toBeCloseTo(getCameraViewHeight(PERSPECTIVE_CAMERA), 5);
  });

  it("toggles repeated directional shortcuts to the paired opposite view", () => {
    const front = cameraStateForViewDirection(PERSPECTIVE_CAMERA, "front", "orthographic");
    const right = cameraStateForViewDirection(PERSPECTIVE_CAMERA, "right", "orthographic");
    const top = cameraStateForViewDirection(PERSPECTIVE_CAMERA, "top", "orthographic");

    expect(resolveRepeatedDirectionalShortcut(front, "front", "back")).toBe("back");
    expect(resolveRepeatedDirectionalShortcut(right, "right", "left")).toBe("left");
    expect(resolveRepeatedDirectionalShortcut(top, "top", "bottom")).toBe("bottom");
  });

  it("restores the remembered perspective distance when leaving orthographic mode", () => {
    rememberPerspectiveCamera(PERSPECTIVE_CAMERA);
    const next = toggleCameraProjectionMode(ORTHOGRAPHIC_CAMERA);
    expect(next.mode).toBe("perspective");
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(PERSPECTIVE_CAMERA), 5);
  });

  it("preserves look direction when toggling projection modes", () => {
    rememberPerspectiveCamera(PERSPECTIVE_CAMERA);
    const orthographic = toggleCameraProjectionMode(PERSPECTIVE_CAMERA);
    const backToPerspective = toggleCameraProjectionMode(orthographic);
    expect(getCameraForward(backToPerspective).dot(getCameraForward(PERSPECTIVE_CAMERA))).toBeGreaterThan(0.999);
  });

  it("steps orbit around the target without changing orbit distance", () => {
    const next = stepOrbitAroundTarget(PERSPECTIVE_CAMERA, Math.PI / 10, Math.PI / 16);
    expect(next.target).toEqual(PERSPECTIVE_CAMERA.target);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(PERSPECTIVE_CAMERA), 5);
    expect(Number.isFinite(next.position[0])).toBe(true);
    expect(Number.isFinite(next.position[1])).toBe(true);
    expect(Number.isFinite(next.position[2])).toBe(true);
  });

  it("matches OrbitControls horizontal drag direction", () => {
    const next = orbitCameraFromPointerDelta(PERSPECTIVE_CAMERA, 20, 0, 400);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(PERSPECTIVE_CAMERA), 5);
    expect(next.position[0]).toBeLessThan(PERSPECTIVE_CAMERA.position[0]);
  });

  it("matches OrbitControls vertical drag direction", () => {
    const next = orbitCameraFromPointerDelta(PERSPECTIVE_CAMERA, 0, 20, 400);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(PERSPECTIVE_CAMERA), 5);
    expect(next.position[1]).toBeGreaterThan(PERSPECTIVE_CAMERA.position[1]);
  });

  it("keeps pointer orbit pitch clamped near the poles", () => {
    const nearTop: CameraState = {
      ...PERSPECTIVE_CAMERA,
      position: [1, 7, 3.01]
    };
    const next = orbitCameraFromPointerDelta(nearTop, 0, -200, 400);
    expect(next.position[0]).toBeCloseTo(nearTop.position[0], 6);
    expect(next.position[1]).toBeCloseTo(nearTop.position[1], 6);
    expect(next.position[2]).toBeCloseTo(nearTop.position[2], 6);
  });
});

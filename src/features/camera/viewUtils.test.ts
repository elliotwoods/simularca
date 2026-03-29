import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  cameraStateForHomeView,
  cameraStateForViewDirection,
  getCameraDistance,
  getCameraForward,
  getCameraViewHeight,
  orbitCameraFromPointerDelta,
  projectWorldDirectionsAtViewportCenter,
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
    const next = toggleCameraProjectionMode(ORTHOGRAPHIC_CAMERA, PERSPECTIVE_CAMERA);
    expect(next.mode).toBe("perspective");
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(PERSPECTIVE_CAMERA), 5);
    expect(next.fov).toBe(PERSPECTIVE_CAMERA.fov);
  });

  it("preserves look direction when toggling projection modes", () => {
    const orthographic = toggleCameraProjectionMode(PERSPECTIVE_CAMERA);
    const backToPerspective = toggleCameraProjectionMode(orthographic, PERSPECTIVE_CAMERA);
    expect(getCameraForward(backToPerspective).dot(getCameraForward(PERSPECTIVE_CAMERA))).toBeGreaterThan(0.999);
  });

  it("falls back to the current orthographic fov and distance when no perspective memory exists", () => {
    const next = toggleCameraProjectionMode(ORTHOGRAPHIC_CAMERA, null);
    expect(next.mode).toBe("perspective");
    expect(next.fov).toBe(ORTHOGRAPHIC_CAMERA.fov);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(ORTHOGRAPHIC_CAMERA), 5);
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

  it("projects viewport-center world directions using the active viewport aspect", () => {
    const xDirection = projectWorldDirectionsAtViewportCenter(PERSPECTIVE_CAMERA, 1, [new THREE.Vector3(1, 0, 0)])[0]!;
    const wideXDirection = projectWorldDirectionsAtViewportCenter(PERSPECTIVE_CAMERA, 2, [new THREE.Vector3(1, 0, 0)])[0]!;
    expect(xDirection.screen.x).toBeGreaterThan(0);
    expect(Math.abs(wideXDirection.screen.x)).toBeLessThan(Math.abs(xDirection.screen.x));
    expect(Math.abs(wideXDirection.screen.y)).toBeCloseTo(Math.abs(xDirection.screen.y), 9);
  });

  it("keeps forward-aligned viewport directions centered in screen space", () => {
    const forward = getCameraForward(PERSPECTIVE_CAMERA);
    const direction = projectWorldDirectionsAtViewportCenter(PERSPECTIVE_CAMERA, 16 / 9, [forward])[0]!;
    expect(direction.screen.length()).toBeLessThan(1e-6);
    expect(direction.depth).toBeCloseTo(1, 6);
  });

  it("matches three.js orthographic top-view screen orientation", () => {
    const top = cameraStateForViewDirection(PERSPECTIVE_CAMERA, "top", "orthographic");
    const [positiveX, positiveZ] = projectWorldDirectionsAtViewportCenter(top, 16 / 9, [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1)
    ]) as [ReturnType<typeof projectWorldDirectionsAtViewportCenter>[number], ReturnType<typeof projectWorldDirectionsAtViewportCenter>[number]];
    expect(positiveX.screen.x).toBeGreaterThan(0);
    expect(Math.abs(positiveX.screen.y)).toBeLessThan(1e-6);
    expect(positiveZ.screen.y).toBeLessThan(0);
    expect(Math.abs(positiveZ.screen.x)).toBeLessThan(1e-6);
  });
});

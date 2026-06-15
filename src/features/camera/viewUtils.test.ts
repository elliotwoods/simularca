import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  cameraStateForHomeView,
  cameraStateForViewDirection,
  computeOrthoEdgeMapping,
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

describe("computeOrthoEdgeMapping", () => {
  const ASPECT = 1.5;

  it("maps a top view to world X (horizontal) and Z (vertical) centred on the target", () => {
    const top: CameraState = {
      mode: "orthographic",
      position: [1, 12, 3],
      target: [1, 2, 3],
      fov: 50,
      zoom: 1.75,
      near: 0.01,
      far: 1000
    };
    const mapping = computeOrthoEdgeMapping(top, ASPECT);
    expect(mapping).not.toBeNull();
    if (!mapping) {
      return;
    }
    expect(mapping.axisU).toBe(0); // X → horizontal
    expect(mapping.axisV).toBe(2); // Z → vertical
    const viewHeight = 16 / 1.75;
    // Centre of each axis is ~the camera target; spans match the ortho frustum.
    // (An exact top-down view has up∥forward, so three.js lookAt applies a tiny
    // nudge — the same one the renderer's grid camera gets, so they stay aligned.
    // That nudge shifts the centre by <0.1, which is why the tolerance is loose.)
    expect(Math.abs((mapping.worldAtLeft + mapping.worldAtRight) / 2 - 1)).toBeLessThan(0.1);
    expect(Math.abs((mapping.worldAtTop + mapping.worldAtBottom) / 2 - 3)).toBeLessThan(0.1);
    expect(Math.abs(mapping.worldAtRight - mapping.worldAtLeft)).toBeCloseTo(viewHeight * ASPECT, 2);
    expect(Math.abs(mapping.worldAtTop - mapping.worldAtBottom)).toBeCloseTo(viewHeight, 2);
  });

  it("maps a front view to world X (horizontal) and Y (vertical)", () => {
    const front: CameraState = {
      mode: "orthographic",
      position: [1, 2, 13],
      target: [1, 2, 3],
      fov: 50,
      zoom: 2,
      near: 0.01,
      far: 1000
    };
    const mapping = computeOrthoEdgeMapping(front, ASPECT);
    expect(mapping?.axisU).toBe(0); // X
    expect(mapping?.axisV).toBe(1); // Y
    expect(mapping ? (mapping.worldAtLeft + mapping.worldAtRight) / 2 : NaN).toBeCloseTo(1, 4);
    expect(mapping ? (mapping.worldAtTop + mapping.worldAtBottom) / 2 : NaN).toBeCloseTo(2, 4);
  });

  it("returns null for perspective and non-axis-aligned orthographic views", () => {
    expect(computeOrthoEdgeMapping(PERSPECTIVE_CAMERA, ASPECT)).toBeNull();
    const iso: CameraState = {
      mode: "orthographic",
      position: [8, 8, 8],
      target: [0, 0, 0],
      fov: 50,
      zoom: 1,
      near: 0.01,
      far: 1000
    };
    expect(computeOrthoEdgeMapping(iso, ASPECT)).toBeNull();
  });
});

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

  it("nudges pointer orbit off the poles instead of freezing", () => {
    const nearTop: CameraState = {
      ...PERSPECTIVE_CAMERA,
      position: [1, 7, 3.01]
    };
    const next = orbitCameraFromPointerDelta(nearTop, 0, -20, 400);
    expect(new THREE.Vector3(...next.position).distanceTo(new THREE.Vector3(...nearTop.position))).toBeGreaterThan(0.1);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(nearTop), 5);
    expect(next.target).toEqual(nearTop.target);
    expect(Math.abs(getCameraForward(next).dot(new THREE.Vector3(0, -1, 0)))).toBeLessThan(0.99995);
  });

  it("can orbit away from an exact top view", () => {
    const top: CameraState = {
      ...PERSPECTIVE_CAMERA,
      position: [1, 7, 3]
    };
    const next = orbitCameraFromPointerDelta(top, 0, -20, 400);
    expect(new THREE.Vector3(...next.position).distanceTo(new THREE.Vector3(...top.position))).toBeGreaterThan(0.1);
    expect(next.position[1]).toBeLessThan(top.position[1]);
    expect(getCameraDistance(next)).toBeCloseTo(getCameraDistance(top), 5);
    expect(next.target).toEqual(top.target);
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

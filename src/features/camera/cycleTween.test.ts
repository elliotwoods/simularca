import { describe, expect, it } from "vitest";
import { interpolateCameraState } from "@/features/camera/cycleTween";
import type { CameraState } from "@/core/types";

describe("camera cycle tween helpers", () => {
  it("interpolates safely across mode transitions", () => {
    const from: CameraState = {
      mode: "perspective",
      position: [6, 4, 6],
      target: [0, 0, 0],
      fov: 50,
      zoom: 1,
      near: 0.01,
      far: 1000
    };
    const to: CameraState = {
      mode: "orthographic",
      position: [8, 8, 8],
      target: [0, 0, 0],
      fov: 50,
      zoom: 1,
      near: 0.01,
      far: 1000
    };
    const mid = interpolateCameraState(from, to, 0.5);
    expect(Number.isFinite(mid.position[0])).toBe(true);
    expect(Number.isFinite(mid.position[1])).toBe(true);
    expect(Number.isFinite(mid.position[2])).toBe(true);
    expect(Number.isFinite(mid.fov)).toBe(true);
    expect(Number.isFinite(mid.zoom)).toBe(true);
  });
});

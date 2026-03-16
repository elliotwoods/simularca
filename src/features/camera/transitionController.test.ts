import { describe, expect, it, vi } from "vitest";
import type { CameraState } from "@/core/types";
import {
  cancelCameraTransition,
  registerCameraTransitionDriver,
  requestCameraTransition
} from "@/features/camera/transitionController";

const CAMERA: CameraState = {
  mode: "perspective",
  position: [1, 2, 3],
  target: [0, 0, 0],
  fov: 50,
  zoom: 1,
  near: 0.01,
  far: 1000
};

describe("camera transition controller", () => {
  it("routes transition requests through the active driver", () => {
    const request = vi.fn();
    const cancel = vi.fn();
    const unregister = registerCameraTransitionDriver({ request, cancel });

    const handled = requestCameraTransition(CAMERA, {
      animated: true,
      durationMs: 500,
      markDirty: true
    });

    unregister();

    expect(handled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toEqual(CAMERA);
    expect(request.mock.calls[0]?.[1]).toEqual({
      animated: true,
      durationMs: 500,
      markDirty: true
    });
  });

  it("cancels the active driver", () => {
    const request = vi.fn();
    const cancel = vi.fn();
    const unregister = registerCameraTransitionDriver({ request, cancel });

    cancelCameraTransition();
    unregister();

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

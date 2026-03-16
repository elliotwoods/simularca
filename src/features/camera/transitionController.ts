import type { CameraState } from "@/core/types";

export const DEFAULT_CAMERA_TRANSITION_DURATION_MS = 500;

export interface CameraTransitionRequestOptions {
  animated?: boolean;
  durationMs?: number;
  markDirty?: boolean;
}

export interface CameraTransitionDriver {
  request(camera: CameraState, options?: CameraTransitionRequestOptions): void;
  cancel(): void;
}

let activeDriver: CameraTransitionDriver | null = null;

export function registerCameraTransitionDriver(driver: CameraTransitionDriver): () => void {
  activeDriver = driver;
  return () => {
    if (activeDriver === driver) {
      activeDriver = null;
    }
  };
}

export function requestCameraTransition(
  camera: CameraState,
  options?: CameraTransitionRequestOptions
): boolean {
  if (!activeDriver) {
    return false;
  }
  activeDriver.request(structuredClone(camera), options);
  return true;
}

export function cancelCameraTransition(): void {
  activeDriver?.cancel();
}

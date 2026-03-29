export const MIN_PERSPECTIVE_PROJECTION_DEPTH = 1e-4;

export function sanitizeCameraNear(cameraNear: number): number {
  if (!Number.isFinite(cameraNear) || cameraNear <= 0) {
    return MIN_PERSPECTIVE_PROJECTION_DEPTH;
  }
  return Math.max(cameraNear, MIN_PERSPECTIVE_PROJECTION_DEPTH);
}

export function clampViewZToPerspectiveNear(viewZ: number, cameraNear: number): number {
  return Math.min(viewZ, -sanitizeCameraNear(cameraNear));
}

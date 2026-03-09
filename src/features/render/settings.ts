import type {
  RenderCameraPathOption,
  RenderResolutionPreset,
  RenderSettings
} from "@/features/render/types";

export interface RenderResolutionPresetInfo {
  id: Exclude<RenderResolutionPreset, "custom">;
  label: string;
  width: number;
  height: number;
}

export const RENDER_RESOLUTION_PRESETS: RenderResolutionPresetInfo[] = [
  { id: "fhd", label: "FHD", width: 1920, height: 1080 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
  { id: "8k", label: "8K", width: 7680, height: 4320 },
  { id: "8k2k", label: "8Kx2K", width: 7680, height: 2160 }
];

export function resolutionForPreset(
  preset: RenderResolutionPreset
): { width: number; height: number } | null {
  const match = RENDER_RESOLUTION_PRESETS.find((entry) => entry.id === preset);
  if (!match) {
    return null;
  }
  return {
    width: match.width,
    height: match.height
  };
}

export function detectResolutionPreset(width: number, height: number): RenderResolutionPreset {
  const match = RENDER_RESOLUTION_PRESETS.find((entry) => entry.width === width && entry.height === height);
  return match?.id ?? "custom";
}

export function defaultRenderCameraPathId<T extends { id: string }>(cameraPathActors: T[]): string {
  return cameraPathActors[0]?.id ?? "";
}

export function findRenderCameraPath(
  cameraPathActors: RenderCameraPathOption[],
  cameraPathId: string
): RenderCameraPathOption | null {
  if (!cameraPathId) {
    return null;
  }
  return cameraPathActors.find((entry) => entry.id === cameraPathId) ?? null;
}

export function resolveRenderDurationSeconds(
  settings: Pick<RenderSettings, "durationSeconds" | "cameraPathId">,
  cameraPathActors: RenderCameraPathOption[]
): number {
  const cameraPath = findRenderCameraPath(cameraPathActors, settings.cameraPathId);
  return cameraPath ? Math.max(0.01, cameraPath.durationSeconds) : settings.durationSeconds;
}

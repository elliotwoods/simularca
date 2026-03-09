export type RenderCaptureStrategy = "pipe" | "temp-folder";

export type RenderStartTimeMode = "current" | "zero";
export type RenderResolutionPreset = "custom" | "fhd" | "4k" | "8k" | "8k2k";
export type RenderSupersampleScale = 1 | 2 | 4;

export interface RenderCameraPathOption {
  id: string;
  label: string;
  durationSeconds: number;
}

export interface RenderSettings {
  resolutionPreset: RenderResolutionPreset;
  width: number;
  height: number;
  supersampleScale: RenderSupersampleScale;
  fps: number;
  bitrateMbps: number;
  durationSeconds: number;
  preRunSeconds: number;
  showDebugViews: boolean;
  startTimeMode: RenderStartTimeMode;
  cameraPathId: string;
  strategy: RenderCaptureStrategy;
}

export interface RenderProgress {
  frameIndex: number;
  frameCount: number;
  message: string;
}

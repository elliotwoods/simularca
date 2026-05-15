import * as THREE from "three";
import type { RenderEngine, SceneColorBufferPrecision } from "@/core/types";

export interface SceneColorBufferSupport {
  float32: boolean;
  float16: boolean;
  uint8: boolean;
}

export interface ResolvedSceneColorBufferPrecision {
  requestedPrecision: SceneColorBufferPrecision;
  activePrecision: SceneColorBufferPrecision;
  requestedAntialiasing: boolean;
  activeAntialiasing: boolean;
  bufferType: THREE.TextureDataType;
  formatLabel: string;
  statusFormatLabel: string;
  warningMessage: string | null;
}

export const SCENE_COLOR_BUFFER_PRECISION_OPTIONS: Array<{
  value: SceneColorBufferPrecision;
  label: string;
}> = [
  { value: "float32", label: "Float32 HDR" },
  { value: "float16", label: "Float16 HDR" },
  { value: "uint8", label: "8-bit SDR" }
];

const SCENE_COLOR_BUFFER_PRECISION_FALLBACK_ORDER: SceneColorBufferPrecision[] = ["float32", "float16", "uint8"];

export function sceneColorBufferPrecisionLabel(precision: SceneColorBufferPrecision): string {
  return SCENE_COLOR_BUFFER_PRECISION_OPTIONS.find((option) => option.value === precision)?.label ?? precision;
}

export function sceneColorBufferFormatLabel(precision: SceneColorBufferPrecision): string {
  switch (precision) {
    case "float32":
      return "RGBA32F";
    case "float16":
      return "RGBA16F";
    case "uint8":
      return "RGBA8";
  }
}

export function sceneColorBufferTextureType(precision: SceneColorBufferPrecision): THREE.TextureDataType {
  switch (precision) {
    case "float32":
      return THREE.FloatType;
    case "float16":
      return THREE.HalfFloatType;
    case "uint8":
      return THREE.UnsignedByteType;
  }
}

export function formatSceneColorBufferStatusLabel(
  backend: RenderEngine,
  precision: SceneColorBufferPrecision
): string {
  return `${backend === "webgl2" ? "WebGL2" : "WebGPU"} ${sceneColorBufferFormatLabel(precision)}`;
}

export function resolveSceneColorBufferPrecision(
  requestedPrecision: SceneColorBufferPrecision,
  support: SceneColorBufferSupport,
  backend: RenderEngine,
  options?: {
    requestedAntialiasing?: boolean;
  }
): ResolvedSceneColorBufferPrecision {
  const requestedIndex = SCENE_COLOR_BUFFER_PRECISION_FALLBACK_ORDER.indexOf(requestedPrecision);
  const fallbackOrder = SCENE_COLOR_BUFFER_PRECISION_FALLBACK_ORDER.slice(
    requestedIndex >= 0 ? requestedIndex : 0
  );
  const activePrecision =
    fallbackOrder.find((precision) => support[precision]) ??
    SCENE_COLOR_BUFFER_PRECISION_FALLBACK_ORDER.find((precision) => support[precision]) ??
    "uint8";
  const requestedAntialiasing = options?.requestedAntialiasing ?? true;
  const activeAntialiasing = !(
    backend === "webgpu" &&
    requestedAntialiasing &&
    activePrecision === "float32"
  );
  const warningMessages: string[] = [];
  if (activePrecision !== requestedPrecision) {
    warningMessages.push(
      `Requested ${sceneColorBufferPrecisionLabel(requestedPrecision)} but fell back to ${sceneColorBufferPrecisionLabel(activePrecision)}.`
    );
  }
  if (requestedAntialiasing && !activeAntialiasing) {
    warningMessages.push(
      `WebGPU ${sceneColorBufferPrecisionLabel(activePrecision)} disables MSAA; rendering without antialiasing.`
    );
  }
  return {
    requestedPrecision,
    activePrecision,
    requestedAntialiasing,
    activeAntialiasing,
    bufferType: sceneColorBufferTextureType(activePrecision),
    formatLabel: sceneColorBufferFormatLabel(activePrecision),
    statusFormatLabel: formatSceneColorBufferStatusLabel(backend, activePrecision),
    warningMessage: warningMessages.length > 0 ? warningMessages.join(" ") : null
  };
}

export function getWebGlColorBufferSupport(renderer: {
  capabilities?: { isWebGL2?: boolean };
  extensions?: { has?: (name: string) => boolean };
}): SceneColorBufferSupport {
  const isWebGl2 = renderer.capabilities?.isWebGL2 === true;
  const hasColorBufferFloat = renderer.extensions?.has?.("EXT_color_buffer_float") === true;
  return {
    float32: isWebGl2 && hasColorBufferFloat,
    float16: isWebGl2 && hasColorBufferFloat,
    uint8: true
  };
}

export function getWebGpuColorBufferSupport(): SceneColorBufferSupport {
  return {
    float32: true,
    float16: true,
    uint8: true
  };
}

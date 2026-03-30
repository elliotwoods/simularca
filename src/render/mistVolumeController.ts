import * as THREE from "three";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, AppState, MistVolumeResource, VolumetricRayFieldResource } from "@/core/types";
import { curveDataWithOverrides, getCurveSamplesPerSegmentFromActor } from "@/features/curves/model";

export type MistVolumeQualityMode = "interactive" | "export";
type MistPreviewMode = "volume" | "bounds" | "slice-x" | "slice-y" | "slice-z" | "off";
type MistDebugOverlayMode = "off" | "numbers" | "density-cells" | "velocity-vectors";
type MistSurfaceMode = "open" | "closed";

interface MistLookupNoiseSettings {
  strength: number;
  scale: number;
  speed: number;
  scroll: THREE.Vector3;
  contrast: number;
  bias: number;
  seed: number;
}

interface MistBoundarySettings {
  negX: MistSurfaceMode;
  posX: MistSurfaceMode;
  negY: MistSurfaceMode;
  posY: MistSurfaceMode;
  negZ: MistSurfaceMode;
  posZ: MistSurfaceMode;
}

interface MistVolumeSourceSample {
  positionLocal: THREE.Vector3;
  directionLocal: THREE.Vector3;
  strength: number;
}

function clampSourceStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, value);
}

function clampMaxSourceSamples(value: number): number {
  if (!Number.isFinite(value)) {
    return 512;
  }
  return Math.max(1, Math.floor(value));
}

function buildVolumetricSourceSample(
  worldPosition: THREE.Vector3,
  worldDirection: THREE.Vector3,
  worldToLocal: THREE.Matrix4,
  strength: number
): MistVolumeSourceSample {
  return {
    positionLocal: worldPosition.clone().applyMatrix4(worldToLocal),
    directionLocal: worldDirection.clone().transformDirection(worldToLocal).normalize(),
    strength: clampSourceStrength(strength)
  };
}

export function collectMistSourcesFromVolumetricRayResourceForTest(
  resource: VolumetricRayFieldResource | null,
  worldToLocalElements?: number[]
): Array<{
  positionLocal: [number, number, number];
  directionLocal: [number, number, number];
  strength: number;
}> {
  const worldToLocal = new THREE.Matrix4();
  if (Array.isArray(worldToLocalElements) && worldToLocalElements.length === 16) {
    worldToLocal.fromArray(worldToLocalElements);
  } else {
    worldToLocal.identity();
  }
  return collectMistSourcesFromVolumetricRayResource(resource, worldToLocal).map((source) => ({
    positionLocal: [source.positionLocal.x, source.positionLocal.y, source.positionLocal.z],
    directionLocal: [source.directionLocal.x, source.directionLocal.y, source.directionLocal.z],
    strength: source.strength
  }));
}

function collectMistSourcesFromVolumetricRayResource(
  resource: VolumetricRayFieldResource | null,
  worldToLocal: THREE.Matrix4
): MistVolumeSourceSample[] {
  if (!resource || resource.kind !== "ray-field" || resource.segments.length === 0) {
    return [];
  }
  const maxSamples = clampMaxSourceSamples(resource.suggestedMaxSamples);
  const spacing = Math.max(1e-3, resource.suggestedSampleSpacingMeters);
  const samplePlan = resource.segments.map((segment) => Math.max(1, Math.ceil(segment.length / spacing)));
  const totalRequested = samplePlan.reduce((sum, count) => sum + count, 0);
  const downsample = totalRequested > maxSamples ? totalRequested / maxSamples : 1;
  const samples: MistVolumeSourceSample[] = [];
  let emittedBudget = 0;
  for (let segmentIndex = 0; segmentIndex < resource.segments.length; segmentIndex += 1) {
    const segment = resource.segments[segmentIndex]!;
    const requestedSamples = samplePlan[segmentIndex]!;
    const worldStart = new THREE.Vector3(...segment.start);
    const worldEnd = new THREE.Vector3(...segment.end);
    const worldDirection = new THREE.Vector3(...segment.direction);
    if (worldDirection.lengthSq() <= 1e-12) {
      continue;
    }
    worldDirection.normalize();
    let emittedForSegment = 0;
    for (let sampleIndex = 0; sampleIndex < requestedSamples; sampleIndex += 1) {
      emittedBudget += 1;
      const currentBucket = Math.floor(emittedBudget / downsample);
      const previousBucket = Math.floor((emittedBudget - 1) / downsample);
      if (currentBucket === previousBucket && downsample > 1) {
        continue;
      }
      const alpha = requestedSamples <= 1 ? 0.5 : sampleIndex / Math.max(1, requestedSamples - 1);
      const worldPosition = worldStart.clone().lerp(worldEnd, alpha);
      emittedForSegment += 1;
      samples.push(
        buildVolumetricSourceSample(
          worldPosition,
          worldDirection,
          worldToLocal,
          segment.weight / requestedSamples
        )
      );
    }
    if (emittedForSegment === 0) {
      samples.push(
        buildVolumetricSourceSample(
          worldStart.clone().lerp(worldEnd, 0.5),
          worldDirection,
          worldToLocal,
          segment.weight
        )
      );
    }
  }
  return samples.slice(0, maxSamples);
}

interface MistVolumeQualitySettings {
  resolution: [number, number, number];
  simulationSubsteps: number;
  previewRaymarchSteps: number;
  qualityMode: MistVolumeQualityMode;
}

interface MistDebugGridResolution {
  x: number;
  y: number;
  z: number;
}

interface MistDebugSettings {
  overlayMode: MistDebugOverlayMode;
  gridResolution: MistDebugGridResolution;
  valueSize: number;
  hideZeroNumbers: boolean;
  densityThreshold: number;
  vectorScale: number;
  sourceMarkers: boolean;
}

interface MistDebugSamplePoint {
  localPosition: THREE.Vector3;
}

interface MistDebugSampleResult {
  density: number;
  rawDensity?: number;
  velocity: THREE.Vector3;
}

interface MistVolumeHelpers {
  getActorById(actorId: string): ActorNode | null;
  getActorObject(actorId: string): unknown | null;
  sampleCurveWorldPoint(
    actorId: string,
    t: number
  ): {
    position: [number, number, number];
    tangent: [number, number, number];
  } | null;
  getVolumetricRayResource(actorId: string): VolumetricRayFieldResource | null;
}

interface MistVolumeBinding {
  actorId: string;
  actorName: string;
  cubeSize: number;
  volumeMatrixWorld: THREE.Matrix4;
  worldToVolumeLocal: THREE.Matrix4;
  resetSignature: string;
}

interface MistVolumeEntry {
  actorId: string;
  previewGroup: THREE.Group;
  debugGroup: THREE.Group;
  debugLabelGroup: THREE.Group;
  debugDensityPoints: THREE.Points;
  debugVelocityLines: THREE.LineSegments;
  debugSourceLines: THREE.LineSegments;
  volumeMesh: THREE.Mesh;
  boundsMesh: THREE.LineSegments;
  sliceMesh: THREE.Mesh;
  volumeMaterial: THREE.ShaderMaterial;
  sliceMaterial: THREE.ShaderMaterial;
  boundsMaterial: THREE.LineBasicMaterial;
  cpuTexture: THREE.Data3DTexture;
  uploadBytes: Uint8Array;
  density: Float32Array;
  densityScratch: Float32Array;
  velocity: Float32Array;
  velocityScratch: Float32Array;
  count: number;
  resolution: [number, number, number];
  lastSignature: string;
  lastSimTimeSeconds: number | null;
  lastLocalCameraInside: boolean;
  debugLabelPlaneGeometry: THREE.PlaneGeometry;
  debugLabelTextureCache: Map<string, { texture: THREE.CanvasTexture; aspect: number }>;
}

interface MistCpuSimulationDiagnostics {
  postInjectRange: [number, number] | "n/a";
  postTransportRange: [number, number] | "n/a";
  postFadeRange: [number, number] | "n/a";
}

function readNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = Number(value);
  let next = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== undefined) {
    next = Math.max(min, next);
  }
  if (max !== undefined) {
    next = Math.min(max, next);
  }
  return next;
}

function readColor(value: unknown, fallback: string): THREE.Color {
  if (typeof value === "string" && (/^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value))) {
    return new THREE.Color(value);
  }
  return new THREE.Color(fallback);
}

function parseActorIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return new THREE.Vector3(...fallback);
}

function readPreviewMode(value: unknown): MistPreviewMode {
  return value === "bounds" || value === "slice-x" || value === "slice-y" || value === "slice-z" || value === "off"
    ? value
    : "volume";
}

function readDebugOverlayMode(value: unknown): MistDebugOverlayMode {
  return value === "numbers" || value === "density-cells" || value === "velocity-vectors" ? value : "off";
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function readSurfaceMode(value: unknown): MistSurfaceMode {
  return value === "closed" ? "closed" : "open";
}

function readLookupNoiseSettings(actor: Pick<ActorNode, "params">): MistLookupNoiseSettings {
  return {
    strength: clamp01(readNumber(actor.params.lookupNoiseStrength, 0.45, 0, 1)),
    scale: readNumber(actor.params.lookupNoiseScale, 1.6, 0.01),
    speed: readNumber(actor.params.lookupNoiseSpeed, 0.12, 0),
    scroll: readVector3(actor.params.lookupNoiseScroll, [0.03, 0.06, 0.02]),
    contrast: readNumber(actor.params.lookupNoiseContrast, 0.9, 0.1),
    bias: readNumber(actor.params.lookupNoiseBias, 0.08, -1, 1),
    seed: Math.floor(readNumber(actor.params.noiseSeed, 1))
  };
}

function readBoundarySettings(actor: Pick<ActorNode, "params">): MistBoundarySettings {
  return {
    negX: readSurfaceMode(actor.params.surfaceNegXMode),
    posX: readSurfaceMode(actor.params.surfacePosXMode),
    negY: readSurfaceMode(actor.params.surfaceNegYMode),
    posY: readSurfaceMode(actor.params.surfacePosYMode),
    negZ: readSurfaceMode(actor.params.surfaceNegZMode),
    posZ: readSurfaceMode(actor.params.surfacePosZMode)
  };
}

function readDebugSettings(actor: Pick<ActorNode, "params">): MistDebugSettings {
  return {
    overlayMode: readDebugOverlayMode(actor.params.debugOverlayMode),
    gridResolution: {
      x: Math.max(1, Math.floor(readNumber(actor.params.debugGridResolutionX, 6, 1, 32))),
      y: Math.max(1, Math.floor(readNumber(actor.params.debugGridResolutionY, 5, 1, 32))),
      z: Math.max(1, Math.floor(readNumber(actor.params.debugGridResolutionZ, 6, 1, 32)))
    },
    valueSize: readNumber(actor.params.debugValueSize, 0.08, 0.02, 1),
    hideZeroNumbers: actor.params.debugHideZeroNumbers !== false,
    densityThreshold: readNumber(actor.params.debugDensityThreshold, 0.02, 0, 1),
    vectorScale: readNumber(actor.params.debugVectorScale, 0.25, 0.01, 4),
    sourceMarkers: actor.params.debugSourceMarkers === true
  };
}

function isLocalCameraInsideUnitCube(localCamera: THREE.Vector3): boolean {
  return (
    localCamera.x >= -0.5 && localCamera.x <= 0.5 &&
    localCamera.y >= -0.5 && localCamera.y <= 0.5 &&
    localCamera.z >= -0.5 && localCamera.z <= 0.5
  );
}

function buildBoundarySummary(boundaries: MistBoundarySettings): string {
  return [
    `L:${boundaries.negX}`,
    `R:${boundaries.posX}`,
    `B:${boundaries.negY}`,
    `T:${boundaries.posY}`,
    `Bk:${boundaries.negZ}`,
    `F:${boundaries.posZ}`
  ].join(" ");
}

function matrixSignature(matrix: THREE.Matrix4): number[] {
  return matrix.elements.map((value) => Number(value.toFixed(6)));
}

function cellIndex(x: number, y: number, z: number, resolution: [number, number, number]): number {
  return x + resolution[0] * (y + resolution[1] * z);
}

function sampleTrilinear(field: Float32Array, resolution: [number, number, number], x: number, y: number, z: number): number {
  const maxX = resolution[0] - 1;
  const maxY = resolution[1] - 1;
  const maxZ = resolution[2] - 1;
  const fx = Math.max(0, Math.min(maxX, x));
  const fy = Math.max(0, Math.min(maxY, y));
  const fz = Math.max(0, Math.min(maxZ, z));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const z1 = Math.min(maxZ, z0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;

  const c000 = field[cellIndex(x0, y0, z0, resolution)] ?? 0;
  const c100 = field[cellIndex(x1, y0, z0, resolution)] ?? 0;
  const c010 = field[cellIndex(x0, y1, z0, resolution)] ?? 0;
  const c110 = field[cellIndex(x1, y1, z0, resolution)] ?? 0;
  const c001 = field[cellIndex(x0, y0, z1, resolution)] ?? 0;
  const c101 = field[cellIndex(x1, y0, z1, resolution)] ?? 0;
  const c011 = field[cellIndex(x0, y1, z1, resolution)] ?? 0;
  const c111 = field[cellIndex(x1, y1, z1, resolution)] ?? 0;

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function sampleVelocityComponentTrilinear(
  field: Float32Array,
  resolution: [number, number, number],
  component: 0 | 1 | 2,
  x: number,
  y: number,
  z: number
): number {
  const maxX = resolution[0] - 1;
  const maxY = resolution[1] - 1;
  const maxZ = resolution[2] - 1;
  const fx = Math.max(0, Math.min(maxX, x));
  const fy = Math.max(0, Math.min(maxY, y));
  const fz = Math.max(0, Math.min(maxZ, z));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const z1 = Math.min(maxZ, z0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;
  const read = (ix: number, iy: number, iz: number) => field[cellIndex(ix, iy, iz, resolution) * 3 + component] ?? 0;
  const c000 = read(x0, y0, z0);
  const c100 = read(x1, y0, z0);
  const c010 = read(x0, y1, z0);
  const c110 = read(x1, y1, z0);
  const c001 = read(x0, y0, z1);
  const c101 = read(x1, y0, z1);
  const c011 = read(x0, y1, z1);
  const c111 = read(x1, y1, z1);
  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothStep01(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function hash4(x: number, y: number, z: number, w: number, seed: number): number {
  const dot =
    x * 127.1 +
    y * 311.7 +
    z * 74.7 +
    w * 19.19 +
    seed * 53.11;
  return fract(Math.sin(dot) * 43758.5453123);
}

function sampleScalarNoise4D(x: number, y: number, z: number, w: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const w0 = Math.floor(w);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const w1 = w0 + 1;
  const tx = smoothStep01(x - x0);
  const ty = smoothStep01(y - y0);
  const tz = smoothStep01(z - z0);
  const tw = smoothStep01(w - w0);

  const v0000 = hash4(x0, y0, z0, w0, seed);
  const v1000 = hash4(x1, y0, z0, w0, seed);
  const v0100 = hash4(x0, y1, z0, w0, seed);
  const v1100 = hash4(x1, y1, z0, w0, seed);
  const v0010 = hash4(x0, y0, z1, w0, seed);
  const v1010 = hash4(x1, y0, z1, w0, seed);
  const v0110 = hash4(x0, y1, z1, w0, seed);
  const v1110 = hash4(x1, y1, z1, w0, seed);
  const v0001 = hash4(x0, y0, z0, w1, seed);
  const v1001 = hash4(x1, y0, z0, w1, seed);
  const v0101 = hash4(x0, y1, z0, w1, seed);
  const v1101 = hash4(x1, y1, z0, w1, seed);
  const v0011 = hash4(x0, y0, z1, w1, seed);
  const v1011 = hash4(x1, y0, z1, w1, seed);
  const v0111 = hash4(x0, y1, z1, w1, seed);
  const v1111 = hash4(x1, y1, z1, w1, seed);

  const x00 = lerp(v0000, v1000, tx);
  const x10 = lerp(v0100, v1100, tx);
  const x20 = lerp(v0010, v1010, tx);
  const x30 = lerp(v0110, v1110, tx);
  const x01 = lerp(v0001, v1001, tx);
  const x11 = lerp(v0101, v1101, tx);
  const x21 = lerp(v0011, v1011, tx);
  const x31 = lerp(v0111, v1111, tx);
  const y00 = lerp(x00, x10, ty);
  const y10 = lerp(x20, x30, ty);
  const y01 = lerp(x01, x11, ty);
  const y11 = lerp(x21, x31, ty);
  const z0v = lerp(y00, y10, tz);
  const z1v = lerp(y01, y11, tz);
  return lerp(z0v, z1v, tw);
}

function sampleVectorNoise4D(
  x: number,
  y: number,
  z: number,
  w: number,
  seed: number,
  scale: number,
  speed: number
): [number, number, number] {
  const sx = x * scale;
  const sy = y * scale;
  const sz = z * scale;
  const sw = w * speed;
  return [
    sampleScalarNoise4D(sx + 11.3, sy + 17.1, sz + 23.7, sw + 3.1, seed * 17 + 1) * 2 - 1,
    sampleScalarNoise4D(sx + 29.5, sy + 31.9, sz + 37.3, sw + 5.7, seed * 17 + 2) * 2 - 1,
    sampleScalarNoise4D(sx + 41.2, sy + 43.8, sz + 47.6, sw + 8.9, seed * 17 + 3) * 2 - 1
  ];
}

function sampleScalarNoiseFromLocalPosition(
  x: number,
  y: number,
  z: number,
  timeSeconds: number,
  seed: number,
  scale: number,
  speed: number
): number {
  return sampleScalarNoise4D(x * scale, y * scale, z * scale, timeSeconds * speed, seed);
}

export function pickMistVolumeQuality(actor: Pick<ActorNode, "params">, qualityMode: MistVolumeQualityMode): MistVolumeQualitySettings {
  const useRender = qualityMode === "export" && actor.params.renderOverrideEnabled === true;
  return {
    resolution: [
      Math.max(4, Math.floor(readNumber(useRender ? actor.params.renderResolutionX : actor.params.resolutionX, 32, 4, 512))),
      Math.max(4, Math.floor(readNumber(useRender ? actor.params.renderResolutionY : actor.params.resolutionY, 24, 4, 512))),
      Math.max(4, Math.floor(readNumber(useRender ? actor.params.renderResolutionZ : actor.params.resolutionZ, 32, 4, 512)))
    ],
    simulationSubsteps: Math.max(1, Math.floor(readNumber(useRender ? actor.params.renderSimulationSubsteps : actor.params.simulationSubsteps, 1, 1, 32))),
    previewRaymarchSteps: Math.max(8, Math.floor(readNumber(useRender ? actor.params.renderPreviewRaymarchSteps : actor.params.previewRaymarchSteps, 48, 8, 512))),
    qualityMode
  };
}

export function computeMistDensityRange(density: Float32Array): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < density.length; index += 1) {
    const value = density[index] ?? 0;
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 0];
  }
  return [Number(min.toFixed(3)), Number(max.toFixed(3))];
}

export function computeMistDensityFadeFactor(fadeRatePerSecond: number, dtSeconds: number): number {
  return Math.exp(-Math.max(0, fadeRatePerSecond) * Math.max(0, dtSeconds));
}

function uploadMistDensityBytes(density: Float32Array, uploadBytes: Uint8Array): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < density.length; index += 1) {
    const byteValue = Math.round(clamp01(density[index] ?? 0) * 255);
    uploadBytes[index] = byteValue;
    min = Math.min(min, byteValue);
    max = Math.max(max, byteValue);
  }
  return !Number.isFinite(min) || !Number.isFinite(max) ? [0, 0] : [min, max];
}

interface MistInjectionSource {
  positionLocal: THREE.Vector3;
  directionLocal: THREE.Vector3;
  strength: number;
}

function injectMistSourcesIntoField(
  density: Float32Array,
  velocity: Float32Array,
  resolution: [number, number, number],
  sources: MistInjectionSource[],
  radiusCells: number,
  densityGain: number,
  initialSpeed: number,
  timeSeconds: number,
  noiseSeed: number,
  emissionNoiseStrength: number,
  emissionNoiseScale: number,
  emissionNoiseSpeed: number
): void {
  for (const source of sources) {
    const sourceStrength = Math.max(0, Number.isFinite(source.strength) ? source.strength : 1);
    if (sourceStrength <= 1e-8) {
      continue;
    }
    const [noiseX, noiseY, noiseZ] = emissionNoiseStrength > 1e-4
      ? sampleVectorNoise4D(
        source.positionLocal.x,
        source.positionLocal.y,
        source.positionLocal.z,
        timeSeconds,
        noiseSeed + 11,
        emissionNoiseScale,
        emissionNoiseSpeed
      )
      : [0, 0, 0];
    const emissionNoiseValue = emissionNoiseStrength > 1e-4
      ? sampleScalarNoiseFromLocalPosition(
        source.positionLocal.x + 13.7,
        source.positionLocal.y - 7.1,
        source.positionLocal.z + 3.9,
        timeSeconds,
        noiseSeed + 29,
        emissionNoiseScale,
        emissionNoiseSpeed
      ) * 2 - 1
      : 0;
    const noisyDensityGain = densityGain * sourceStrength * Math.max(0, 1 + emissionNoiseValue * emissionNoiseStrength * 0.6);
    const noisyInitialSpeed = initialSpeed * sourceStrength * Math.max(0, 1 + emissionNoiseValue * emissionNoiseStrength * 0.35);
    const noisyDirection = emissionNoiseStrength > 1e-4
      ? source.directionLocal.clone().add(new THREE.Vector3(noiseX, noiseY, noiseZ).multiplyScalar(emissionNoiseStrength * 0.45)).normalize()
      : source.directionLocal;
    const cx = ((source.positionLocal.x + 0.5) * (resolution[0] - 1));
    const cy = ((source.positionLocal.y + 0.5) * (resolution[1] - 1));
    const cz = ((source.positionLocal.z + 0.5) * (resolution[2] - 1));
    const minX = Math.max(0, Math.floor(cx - radiusCells));
    const maxX = Math.min(resolution[0] - 1, Math.ceil(cx + radiusCells));
    const minY = Math.max(0, Math.floor(cy - radiusCells));
    const maxY = Math.min(resolution[1] - 1, Math.ceil(cy + radiusCells));
    const minZ = Math.max(0, Math.floor(cz - radiusCells));
    const maxZ = Math.min(resolution[2] - 1, Math.ceil(cz + radiusCells));
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const dx = (x - cx) / Math.max(1, radiusCells);
          const dy = (y - cy) / Math.max(1, radiusCells);
          const dz = (z - cz) / Math.max(1, radiusCells);
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > 1) {
            continue;
          }
          const weight = 1 - dist2;
          const index = cellIndex(x, y, z, resolution);
          density[index] = Math.max(0, (density[index] ?? 0) + noisyDensityGain * weight);
          const velocityIndex = index * 3;
          velocity[velocityIndex] = (velocity[velocityIndex] ?? 0) + noisyDirection.x * noisyInitialSpeed * weight;
          velocity[velocityIndex + 1] = (velocity[velocityIndex + 1] ?? 0) + noisyDirection.y * noisyInitialSpeed * weight;
          velocity[velocityIndex + 2] = (velocity[velocityIndex + 2] ?? 0) + noisyDirection.z * noisyInitialSpeed * weight;
        }
      }
    }
  }
}

export function simulateMistCpuInjectionForTest(options?: {
  resolution?: [number, number, number];
  sources?: Array<{ positionLocal: [number, number, number]; directionLocal: [number, number, number]; strength?: number }>;
  radiusCells?: number;
  densityGain?: number;
  initialSpeed?: number;
  timeSeconds?: number;
}): { densityRange: [number, number]; uploadByteRange: [number, number] } {
  const resolution = options?.resolution ?? [8, 8, 8];
  const count = resolution[0] * resolution[1] * resolution[2];
  const density = new Float32Array(count);
  const velocity = new Float32Array(count * 3);
  const uploadBytes = new Uint8Array(count);
  const sources = (options?.sources ?? [
    { positionLocal: [0, 0, 0] as [number, number, number], directionLocal: [0, -1, 0] as [number, number, number], strength: 1 }
  ]).map((source) => ({
    positionLocal: new THREE.Vector3(...source.positionLocal),
    directionLocal: new THREE.Vector3(...source.directionLocal).normalize(),
    strength: source.strength ?? 1
  }));
  injectMistSourcesIntoField(
    density,
    velocity,
    resolution,
    sources,
    options?.radiusCells ?? 2,
    options?.densityGain ?? 0.25,
    options?.initialSpeed ?? 0.6,
    options?.timeSeconds ?? 0,
    1,
    0,
    1,
    0
  );
  const uploadByteRange = uploadMistDensityBytes(density, uploadBytes);
  return {
    densityRange: computeMistDensityRange(density),
    uploadByteRange
  };
}

function sampleDensityWithBoundariesForTest(
  density: Float32Array,
  resolution: [number, number, number],
  boundaries: MistBoundarySettings,
  x: number,
  y: number,
  z: number
): number {
  const maxX = resolution[0] - 1;
  const maxY = resolution[1] - 1;
  const maxZ = resolution[2] - 1;
  if ((x < 0 && boundaries.negX === "open") || (x > maxX && boundaries.posX === "open")) {
    return 0;
  }
  if ((y < 0 && boundaries.negY === "open") || (y > maxY && boundaries.posY === "open")) {
    return 0;
  }
  if ((z < 0 && boundaries.negZ === "open") || (z > maxZ && boundaries.posZ === "open")) {
    return 0;
  }
  return sampleTrilinear(
    density,
    resolution,
    Math.max(0, Math.min(maxX, x)),
    Math.max(0, Math.min(maxY, y)),
    Math.max(0, Math.min(maxZ, z))
  );
}

function applyMistNoiseForcesForTest(
  density: Float32Array,
  velocity: Float32Array,
  resolution: [number, number, number],
  stepDt: number,
  timeSeconds: number,
  noiseSeed: number,
  windVector: THREE.Vector3,
  windNoiseStrength: number,
  windNoiseScale: number,
  windNoiseSpeed: number,
  wispiness: number
): void {
  const hasBaseWind = windVector.lengthSq() > 1e-8;
  const hasWindNoise = windNoiseStrength > 1e-4;
  const hasWispiness = wispiness > 1e-4;
  if (!hasBaseWind && !hasWindNoise && !hasWispiness) {
    return;
  }
  const maxX = Math.max(1, resolution[0] - 1);
  const maxY = Math.max(1, resolution[1] - 1);
  const maxZ = Math.max(1, resolution[2] - 1);
  for (let z = 0; z < resolution[2]; z += 1) {
    for (let y = 0; y < resolution[1]; y += 1) {
      for (let x = 0; x < resolution[0]; x += 1) {
        const index = cellIndex(x, y, z, resolution);
        const localDensity = density[index] ?? 0;
        const densityInfluence = clamp01(localDensity * 1.8);
        if (densityInfluence <= 1e-4) {
          continue;
        }
        const localX = x / maxX - 0.5;
        const localY = y / maxY - 0.5;
        const localZ = z / maxZ - 0.5;
        const velocityIndex = index * 3;
        velocity[velocityIndex] = (velocity[velocityIndex] ?? 0) + windVector.x * stepDt * densityInfluence;
        velocity[velocityIndex + 1] = (velocity[velocityIndex + 1] ?? 0) + windVector.y * stepDt * densityInfluence;
        velocity[velocityIndex + 2] = (velocity[velocityIndex + 2] ?? 0) + windVector.z * stepDt * densityInfluence;
        if (hasWindNoise) {
          const [windNx, windNy, windNz] = sampleVectorNoise4D(
            localX + 7.3,
            localY - 2.1,
            localZ + 4.8,
            timeSeconds,
            noiseSeed + 101,
            windNoiseScale,
            windNoiseSpeed
          );
          const windScale = windNoiseStrength * stepDt * densityInfluence;
          velocity[velocityIndex] = (velocity[velocityIndex] ?? 0) + windNx * windScale;
          velocity[velocityIndex + 1] = (velocity[velocityIndex + 1] ?? 0) + windNy * windScale;
          velocity[velocityIndex + 2] = (velocity[velocityIndex + 2] ?? 0) + windNz * windScale;
        }
        if (hasWispiness) {
          const [wispNx, wispNy, wispNz] = sampleVectorNoise4D(
            localX - 3.7,
            localY + 12.8,
            localZ + 19.6,
            timeSeconds,
            noiseSeed + 211,
            2.5 + wispiness * 2,
            0.45 + wispiness * 0.15
          );
          const wispScale = wispiness * stepDt * densityInfluence * 0.75;
          velocity[velocityIndex] = (velocity[velocityIndex] ?? 0) + wispNx * wispScale;
          velocity[velocityIndex + 1] = (velocity[velocityIndex + 1] ?? 0) + wispNy * wispScale;
          velocity[velocityIndex + 2] = (velocity[velocityIndex + 2] ?? 0) + wispNz * wispScale;
        }
      }
    }
  }
}

function diffuseMistVelocityForTest(
  velocity: Float32Array,
  velocityScratch: Float32Array,
  resolution: [number, number, number],
  diffusion: number,
  stepDt: number
): void {
  const mixAmount = clamp01(diffusion * stepDt * 8);
  for (let z = 0; z < resolution[2]; z += 1) {
    for (let y = 0; y < resolution[1]; y += 1) {
      for (let x = 0; x < resolution[0]; x += 1) {
        const index = cellIndex(x, y, z, resolution);
        const base = index * 3;
        for (let component = 0 as 0 | 1 | 2; component < 3; component = (component + 1) as 0 | 1 | 2) {
          let sum = 0;
          let count = 0;
          const offsets = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const;
          for (const [ox, oy, oz] of offsets) {
            const nx = x + ox;
            const ny = y + oy;
            const nz = z + oz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= resolution[0] || ny >= resolution[1] || nz >= resolution[2]) {
              continue;
            }
            sum += velocity[cellIndex(nx, ny, nz, resolution) * 3 + component] ?? 0;
            count += 1;
          }
          const current = velocity[base + component] ?? 0;
          const smoothed = count > 0 ? sum / count : current;
          velocityScratch[base + component] = current * (1 - mixAmount) + smoothed * mixAmount;
        }
      }
    }
  }
  velocity.set(velocityScratch);
}

function advectMistDensityForTest(
  density: Float32Array,
  densityScratch: Float32Array,
  velocity: Float32Array,
  resolution: [number, number, number],
  stepDt: number,
  boundaries: MistBoundarySettings
): void {
  for (let z = 0; z < resolution[2]; z += 1) {
    for (let y = 0; y < resolution[1]; y += 1) {
      for (let x = 0; x < resolution[0]; x += 1) {
        const index = cellIndex(x, y, z, resolution);
        const base = index * 3;
        const vx = velocity[base] ?? 0;
        const vy = velocity[base + 1] ?? 0;
        const vz = velocity[base + 2] ?? 0;
        const backX = x - vx * stepDt * resolution[0];
        const backY = y - vy * stepDt * resolution[1];
        const backZ = z - vz * stepDt * resolution[2];
        densityScratch[index] = sampleDensityWithBoundariesForTest(density, resolution, boundaries, backX, backY, backZ);
      }
    }
  }
  density.set(densityScratch);
}

function transportMistDensityForTest(
  density: Float32Array,
  densityScratch: Float32Array,
  velocity: Float32Array,
  resolution: [number, number, number],
  stepDt: number,
  boundaries: MistBoundarySettings,
  diffusion: number
): void {
  advectMistDensityForTest(density, densityScratch, velocity, resolution, stepDt, boundaries);
  applyMistDensityDiffusionForTest(density, densityScratch, resolution, diffusion);
}

function applyMistDensityDiffusionForTest(
  density: Float32Array,
  densityScratch: Float32Array,
  resolution: [number, number, number],
  diffusion: number
): void {
  const mixAmount = clamp01(diffusion * 0.4);
  if (mixAmount <= 0) {
    return;
  }
  for (let z = 0; z < resolution[2]; z += 1) {
    for (let y = 0; y < resolution[1]; y += 1) {
      for (let x = 0; x < resolution[0]; x += 1) {
        const index = cellIndex(x, y, z, resolution);
        let sum = 0;
        let count = 0;
        const offsets = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const;
        for (const [ox, oy, oz] of offsets) {
          const nx = x + ox;
          const ny = y + oy;
          const nz = z + oz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= resolution[0] || ny >= resolution[1] || nz >= resolution[2]) {
            continue;
          }
          sum += density[cellIndex(nx, ny, nz, resolution)] ?? 0;
          count += 1;
        }
        const current = density[index] ?? 0;
        const smoothed = count > 0 ? sum / count : current;
        densityScratch[index] = current * (1 - mixAmount) + smoothed * mixAmount;
      }
    }
  }
  density.set(densityScratch);
}

function applyMistDensityDecayForTest(
  density: Float32Array,
  resolution: [number, number, number],
  densityDecay: number,
  stepDt: number,
  edgeBreakup: number,
  timeSeconds: number,
  noiseSeed: number
): void {
  const decayFactor = computeMistDensityFadeFactor(densityDecay, stepDt);
  const maxX = Math.max(1, resolution[0] - 1);
  const maxY = Math.max(1, resolution[1] - 1);
  const maxZ = Math.max(1, resolution[2] - 1);
  for (let index = 0; index < density.length; index += 1) {
    const current = density[index] ?? 0;
    let next = current * decayFactor;
    if (edgeBreakup > 1e-4 && current > 1e-4) {
      const x = index % resolution[0];
      const yz = Math.floor(index / resolution[0]);
      const y = yz % resolution[1];
      const z = Math.floor(yz / resolution[1]);
      let sum = 0;
      let count = 0;
      const offsets = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const;
      for (const [ox, oy, oz] of offsets) {
        const nx = x + ox;
        const ny = y + oy;
        const nz = z + oz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= resolution[0] || ny >= resolution[1] || nz >= resolution[2]) {
          continue;
        }
        sum += density[cellIndex(nx, ny, nz, resolution)] ?? 0;
        count += 1;
      }
      const neighborAverage = count > 0 ? sum / count : current;
      const edgeFactor = clamp01(Math.abs(current - neighborAverage) * 8 + current * (1 - current) * 1.5);
      const localX = x / maxX - 0.5;
      const localY = y / maxY - 0.5;
      const localZ = z / maxZ - 0.5;
      const breakupNoise =
        sampleScalarNoiseFromLocalPosition(localX + 5.1, localY - 8.2, localZ + 11.7, timeSeconds, noiseSeed + 307, 2.8, 0.35) * 2 - 1;
      const extraDecay = Math.max(0, breakupNoise) * edgeBreakup * edgeFactor * stepDt * 0.9;
      next *= Math.max(0, 1 - extraDecay);
    }
    density[index] = Math.max(0, next);
  }
}

function applyMistVelocityForcesForTest(
  density: Float32Array,
  velocity: Float32Array,
  resolution: [number, number, number],
  buoyancy: number,
  velocityDrag: number,
  stepDt: number,
  boundaries: MistBoundarySettings
): void {
  const dragFactor = Math.max(0, 1 - velocityDrag * stepDt);
  for (let z = 0; z < resolution[2]; z += 1) {
    for (let y = 0; y < resolution[1]; y += 1) {
      for (let x = 0; x < resolution[0]; x += 1) {
        const index = cellIndex(x, y, z, resolution);
        const base = index * 3;
        const currentDensity = density[index] ?? 0;
        let vx = (velocity[base] ?? 0) * dragFactor;
        let vy = ((velocity[base + 1] ?? 0) + buoyancy * currentDensity * stepDt) * dragFactor;
        let vz = (velocity[base + 2] ?? 0) * dragFactor;
        if (x === 0 && boundaries.negX === "closed") {
          vx = Math.max(0, vx);
        }
        if (x === resolution[0] - 1 && boundaries.posX === "closed") {
          vx = Math.min(0, vx);
        }
        if (y === 0 && boundaries.negY === "closed") {
          vy = Math.max(0, vy);
        }
        if (y === resolution[1] - 1 && boundaries.posY === "closed") {
          vy = Math.min(0, vy);
        }
        if (z === 0 && boundaries.negZ === "closed") {
          vz = Math.max(0, vz);
        }
        if (z === resolution[2] - 1 && boundaries.posZ === "closed") {
          vz = Math.min(0, vz);
        }
        velocity[base] = vx;
        velocity[base + 1] = vy;
        velocity[base + 2] = vz;
      }
    }
  }
}

function countMistVoxelsAboveThresholdForTest(density: Float32Array, threshold: number): number {
  let count = 0;
  for (let index = 0; index < density.length; index += 1) {
    if ((density[index] ?? 0) > threshold) {
      count += 1;
    }
  }
  return count;
}

function sumMistDensityForTest(density: Float32Array): number {
  let total = 0;
  for (let index = 0; index < density.length; index += 1) {
    total += density[index] ?? 0;
  }
  return total;
}

function preserveMistDensityMassForBoundaries(
  density: Float32Array,
  targetRetainedDensity: number
): void {
  if (targetRetainedDensity <= 1e-8) {
    return;
  }
  const currentTotalDensity = sumMistDensityForTest(density);
  if (currentTotalDensity <= 1e-8) {
    return;
  }
  const scale = targetRetainedDensity / currentTotalDensity;
  if (!Number.isFinite(scale) || Math.abs(scale - 1) <= 1e-4) {
    return;
  }
  for (let index = 0; index < density.length; index += 1) {
    density[index] = Math.max(0, (density[index] ?? 0) * scale);
  }
}

function sampleMistCpuDensityAtLocalPositionForTest(
  density: Float32Array,
  resolution: [number, number, number],
  positionLocal: [number, number, number]
): number {
  const uvw = new THREE.Vector3(...positionLocal).addScalar(0.5);
  return sampleTrilinear(
    density,
    resolution,
    uvw.x * (resolution[0] - 1),
    uvw.y * (resolution[1] - 1),
    uvw.z * (resolution[2] - 1)
  );
}

function seedMistDensityBlobsForTest(
  density: Float32Array,
  resolution: [number, number, number],
  blobs: Array<{ positionLocal: [number, number, number]; value: number; radiusCells?: number }>
): void {
  for (const blob of blobs) {
    const cx = (blob.positionLocal[0] + 0.5) * (resolution[0] - 1);
    const cy = (blob.positionLocal[1] + 0.5) * (resolution[1] - 1);
    const cz = (blob.positionLocal[2] + 0.5) * (resolution[2] - 1);
    const radiusCells = Math.max(0, Math.floor(blob.radiusCells ?? 0));
    const minX = Math.max(0, Math.floor(cx - radiusCells));
    const maxX = Math.min(resolution[0] - 1, Math.ceil(cx + radiusCells));
    const minY = Math.max(0, Math.floor(cy - radiusCells));
    const maxY = Math.min(resolution[1] - 1, Math.ceil(cy + radiusCells));
    const minZ = Math.max(0, Math.floor(cz - radiusCells));
    const maxZ = Math.min(resolution[2] - 1, Math.ceil(cz + radiusCells));
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const dx = radiusCells > 0 ? (x - cx) / radiusCells : 0;
          const dy = radiusCells > 0 ? (y - cy) / radiusCells : 0;
          const dz = radiusCells > 0 ? (z - cz) / radiusCells : 0;
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > 1) {
            continue;
          }
          const weight = radiusCells > 0 ? 1 - dist2 : 1;
          density[cellIndex(x, y, z, resolution)] = Math.max(density[cellIndex(x, y, z, resolution)] ?? 0, blob.value * weight);
        }
      }
    }
  }
}

export function runMistCpuSimulationForTest(options?: {
  resolution?: [number, number, number];
  steps?: number;
  dtSeconds?: number;
  simulationSubsteps?: number;
  sources?: Array<{ positionLocal: [number, number, number]; directionLocal: [number, number, number]; strength?: number }>;
  initialDensityBlobs?: Array<{ positionLocal: [number, number, number]; value: number; radiusCells?: number }>;
  sourceRadius?: number;
  injectionRate?: number;
  initialSpeed?: number;
  buoyancy?: number;
  velocityDrag?: number;
  diffusion?: number;
  densityDecay?: number;
  edgeBreakup?: number;
  noiseSeed?: number;
  emissionNoiseStrength?: number;
  emissionNoiseScale?: number;
  emissionNoiseSpeed?: number;
  windVector?: [number, number, number];
  windNoiseStrength?: number;
  windNoiseScale?: number;
  windNoiseSpeed?: number;
  wispiness?: number;
  boundaries?: Partial<{
    negX: "open" | "closed";
    posX: "open" | "closed";
    negY: "open" | "closed";
    posY: "open" | "closed";
    negZ: "open" | "closed";
    posZ: "open" | "closed";
  }>;
  threshold?: number;
}): {
  densityRange: [number, number];
  totalDensity: number;
  nonZeroFraction: number;
  saturatedFraction: number;
  centerDensity: number;
  cornerDensity: number;
  faceDensity: number;
  density: Float32Array;
  velocity: Float32Array;
  stepDiagnostics: Array<{
    postInjectRange: [number, number] | "n/a";
    postTransportRange: [number, number] | "n/a";
    postFadeRange: [number, number] | "n/a";
  }>;
} {
  const resolution = options?.resolution ?? [12, 12, 12];
  const count = resolution[0] * resolution[1] * resolution[2];
  const density = new Float32Array(count);
  const densityScratch = new Float32Array(count);
  const velocity = new Float32Array(count * 3);
  const velocityScratch = new Float32Array(count * 3);
  if (options?.initialDensityBlobs?.length) {
    seedMistDensityBlobsForTest(density, resolution, options.initialDensityBlobs);
  }
  const sources = (options?.sources ?? [
    { positionLocal: [0, 0, 0] as [number, number, number], directionLocal: [0, -1, 0] as [number, number, number], strength: 1 }
  ]).map((source) => ({
    positionLocal: new THREE.Vector3(...source.positionLocal),
    directionLocal: new THREE.Vector3(...source.directionLocal).normalize(),
    strength: source.strength ?? 1
  }));
  const steps = Math.max(0, Math.floor(options?.steps ?? 1));
  const simulationSubsteps = Math.max(1, Math.floor(options?.simulationSubsteps ?? 1));
  const dtSeconds = Math.max(0, options?.dtSeconds ?? 1 / 30);
  const stepDt = dtSeconds / simulationSubsteps;
  const noiseSeed = Math.floor(options?.noiseSeed ?? 1);
  const sourceRadius = Math.max(0.01, options?.sourceRadius ?? 0.2);
  const injectionRate = Math.max(0, options?.injectionRate ?? 1);
  const initialSpeed = Math.max(0, options?.initialSpeed ?? 0.6);
  const buoyancy = options?.buoyancy ?? 0.35;
  const velocityDrag = clamp01(options?.velocityDrag ?? 0.12);
  const diffusion = Math.max(0, options?.diffusion ?? 0.04);
  const densityDecay = Math.max(0, options?.densityDecay ?? 0);
  const edgeBreakup = Math.max(0, options?.edgeBreakup ?? 0);
  const emissionNoiseStrength = Math.max(0, options?.emissionNoiseStrength ?? 0);
  const emissionNoiseScale = Math.max(0.01, options?.emissionNoiseScale ?? 1);
  const emissionNoiseSpeed = Math.max(0, options?.emissionNoiseSpeed ?? 0.75);
  const windVector = new THREE.Vector3(...(options?.windVector ?? [0, 0, 0]));
  const windNoiseStrength = Math.max(0, options?.windNoiseStrength ?? 0);
  const windNoiseScale = Math.max(0.01, options?.windNoiseScale ?? 0.75);
  const windNoiseSpeed = Math.max(0, options?.windNoiseSpeed ?? 0.25);
  const wispiness = Math.max(0, options?.wispiness ?? 0);
  const boundaries: MistBoundarySettings = {
    negX: options?.boundaries?.negX ?? "closed",
    posX: options?.boundaries?.posX ?? "closed",
    negY: options?.boundaries?.negY ?? "closed",
    posY: options?.boundaries?.posY ?? "closed",
    negZ: options?.boundaries?.negZ ?? "closed",
    posZ: options?.boundaries?.posZ ?? "closed"
  };
  const closedBoundaries: MistBoundarySettings = {
    negX: "closed",
    posX: "closed",
    negY: "closed",
    posY: "closed",
    negZ: "closed",
    posZ: "closed"
  };
  const radiusCells = Math.max(1, Math.ceil(sourceRadius * Math.max(resolution[0], resolution[1], resolution[2])));
  const stepDiagnostics: MistCpuSimulationDiagnostics[] = [];

  for (let step = 0; step < steps; step += 1) {
    let postInjectRange: [number, number] | "n/a" = "n/a";
    let postTransportRange: [number, number] | "n/a" = "n/a";
    for (let substep = 0; substep < simulationSubsteps; substep += 1) {
      const stepTime = step * dtSeconds + stepDt * (substep + 1);
      injectMistSourcesIntoField(
        density,
        velocity,
        resolution,
        sources,
        radiusCells,
        injectionRate * stepDt,
        initialSpeed,
        stepTime,
        noiseSeed,
        emissionNoiseStrength,
        emissionNoiseScale,
        emissionNoiseSpeed
      );
      postInjectRange = computeMistDensityRange(density);
      const postInjectTotalDensity = sumMistDensityForTest(density);
      const densityBeforeTransport = density.slice();
      const closedTransportDensity = density.slice();
      const closedTransportScratch = new Float32Array(count);
      applyMistNoiseForcesForTest(
        density,
        velocity,
        resolution,
        stepDt,
        stepTime,
        noiseSeed,
        windVector,
        windNoiseStrength,
        windNoiseScale,
        windNoiseSpeed,
        wispiness
      );
      diffuseMistVelocityForTest(velocity, velocityScratch, resolution, diffusion, stepDt);
      transportMistDensityForTest(closedTransportDensity, closedTransportScratch, velocity, resolution, stepDt, closedBoundaries, diffusion);
      density.set(densityBeforeTransport);
      transportMistDensityForTest(density, densityScratch, velocity, resolution, stepDt, boundaries, diffusion);
      const legitimateOutflow = Math.max(0, sumMistDensityForTest(closedTransportDensity) - sumMistDensityForTest(density));
      preserveMistDensityMassForBoundaries(density, Math.max(0, postInjectTotalDensity - legitimateOutflow));
      postTransportRange = computeMistDensityRange(density);
      applyMistDensityDecayForTest(density, resolution, densityDecay, stepDt, edgeBreakup, stepTime, noiseSeed);
      applyMistVelocityForcesForTest(density, velocity, resolution, buoyancy, velocityDrag, stepDt, boundaries);
    }
    stepDiagnostics.push({
      postInjectRange,
      postTransportRange,
      postFadeRange: computeMistDensityRange(density)
    });
  }

  const threshold = Math.max(0, options?.threshold ?? 1e-4);
  const nonZeroCount = countMistVoxelsAboveThresholdForTest(density, threshold);
  const saturatedCount = countMistVoxelsAboveThresholdForTest(density, 0.999);
  return {
    densityRange: computeMistDensityRange(density),
    totalDensity: sumMistDensityForTest(density),
    nonZeroFraction: nonZeroCount / Math.max(1, count),
    saturatedFraction: saturatedCount / Math.max(1, count),
    centerDensity: sampleMistCpuDensityAtLocalPositionForTest(density, resolution, [0, 0, 0]),
    cornerDensity: sampleMistCpuDensityAtLocalPositionForTest(density, resolution, [0.48, 0.48, 0.48]),
    faceDensity: sampleMistCpuDensityAtLocalPositionForTest(density, resolution, [0, 0.48, 0]),
    density,
    velocity,
    stepDiagnostics
  };
}


function createVolumePreviewMaterial(texture: THREE.Data3DTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    uniforms: {
      uDensityTex: { value: texture },
      uPreviewTint: { value: new THREE.Color("#d9eef7") },
      uOpacityScale: { value: 1.1 },
      uDensityThreshold: { value: 0.02 },
      uRaymarchSteps: { value: 48 },
      uWorldToLocal: { value: new THREE.Matrix4() },
      uMistTimeSeconds: { value: 0 },
      uMistNoiseStrength: { value: 0.45 },
      uMistNoiseScale: { value: 1.6 },
      uMistNoiseSpeed: { value: 0.12 },
      uMistNoiseScroll: { value: new THREE.Vector3(0.03, 0.06, 0.02) },
      uMistNoiseContrast: { value: 0.9 },
      uMistNoiseBias: { value: 0.08 },
      uMistNoiseSeed: { value: 1 }
    },
    vertexShader: `
      varying vec3 vLocalPosition;
      varying vec3 vWorldPosition;

      void main() {
        vLocalPosition = position;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      precision highp sampler3D;

      uniform sampler3D uDensityTex;
      uniform vec3 uPreviewTint;
      uniform float uOpacityScale;
      uniform float uDensityThreshold;
      uniform float uRaymarchSteps;
      uniform mat4 uWorldToLocal;
      uniform float uMistTimeSeconds;
      uniform float uMistNoiseStrength;
      uniform float uMistNoiseScale;
      uniform float uMistNoiseSpeed;
      uniform vec3 uMistNoiseScroll;
      uniform float uMistNoiseContrast;
      uniform float uMistNoiseBias;
      uniform float uMistNoiseSeed;

      varying vec3 vLocalPosition;
      varying vec3 vWorldPosition;

      bool intersectBox(vec3 rayOrigin, vec3 rayDir, out float tNear, out float tFar) {
        vec3 boxMin = vec3(-0.5);
        vec3 boxMax = vec3(0.5);
        vec3 invDir = 1.0 / max(abs(rayDir), vec3(1e-5)) * sign(rayDir);
        vec3 t0 = (boxMin - rayOrigin) * invDir;
        vec3 t1 = (boxMax - rayOrigin) * invDir;
        vec3 tMin = min(t0, t1);
        vec3 tMax = max(t0, t1);
        tNear = max(max(tMin.x, tMin.y), tMin.z);
        tFar = min(min(tMax.x, tMax.y), tMax.z);
        return tFar > max(tNear, 0.0);
      }

      float hash31(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      vec3 grad3(vec3 cell) {
        float x = hash31(cell + vec3(11.3, 0.0, 0.0)) * 2.0 - 1.0;
        float y = hash31(cell + vec3(0.0, 17.1, 0.0)) * 2.0 - 1.0;
        float z = hash31(cell + vec3(0.0, 0.0, 23.7)) * 2.0 - 1.0;
        return normalize(vec3(x, y, z) + vec3(1e-4));
      }

      float gradientNoise3D(vec3 p) {
        vec3 cell = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);

        float n000 = dot(grad3(cell + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
        float n100 = dot(grad3(cell + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
        float n010 = dot(grad3(cell + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
        float n110 = dot(grad3(cell + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
        float n001 = dot(grad3(cell + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
        float n101 = dot(grad3(cell + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
        float n011 = dot(grad3(cell + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
        float n111 = dot(grad3(cell + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));

        float nx00 = mix(n000, n100, u.x);
        float nx10 = mix(n010, n110, u.x);
        float nx01 = mix(n001, n101, u.x);
        float nx11 = mix(n011, n111, u.x);
        float nxy0 = mix(nx00, nx10, u.y);
        float nxy1 = mix(nx01, nx11, u.y);
        return mix(nxy0, nxy1, u.z);
      }

      float sampleLookupNoise(vec3 localPosition) {
        if (uMistNoiseStrength <= 1e-4) {
          return 1.0;
        }
        vec3 noisePosition =
          (localPosition + vec3(0.5) + uMistNoiseScroll * uMistTimeSeconds * uMistNoiseSpeed)
          * uMistNoiseScale
          + vec3(uMistNoiseSeed * 0.031);
        float noiseA = gradientNoise3D(noisePosition);
        float noiseB = gradientNoise3D(noisePosition * 2.03 + vec3(17.1, -9.4, 5.2));
        float noise = clamp(0.5 + 0.5 * (noiseA * 0.7 + noiseB * 0.3), 0.0, 1.0);
        float contrasted = clamp((noise - 0.5) * uMistNoiseContrast + 0.5 + uMistNoiseBias, 0.0, 1.0);
        return mix(1.0, contrasted, clamp(uMistNoiseStrength, 0.0, 1.0));
      }

      float sampleMistDensityLocal(vec3 localPosition) {
        vec3 uvw = localPosition + vec3(0.5);
        if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) {
          return 0.0;
        }
        float density = texture(uDensityTex, uvw).r;
        return clamp(density * sampleLookupNoise(localPosition), 0.0, 1.0);
      }

      void main() {
        vec3 localCamera = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz;
        vec3 rayOrigin = localCamera;
        vec3 rayDir = normalize((uWorldToLocal * vec4(vWorldPosition, 1.0)).xyz - localCamera);
        float tNear;
        float tFar;
        if (!intersectBox(rayOrigin, rayDir, tNear, tFar)) {
          discard;
        }
        float steps = max(8.0, uRaymarchSteps);
        float dt = max((tFar - max(tNear, 0.0)) / steps, 1e-4);
        vec3 samplePos = rayOrigin + rayDir * max(tNear, 0.0);
        vec3 rgb = vec3(0.0);
        float alpha = 0.0;
        for (float i = 0.0; i < 512.0; i += 1.0) {
          if (i >= steps || alpha >= 0.995) {
            break;
          }
          float density = sampleMistDensityLocal(samplePos);
          if (density > uDensityThreshold) {
            float a = clamp(density * uOpacityScale * dt * 4.0, 0.0, 1.0);
            rgb += (1.0 - alpha) * uPreviewTint * a;
            alpha += (1.0 - alpha) * a;
          }
          samplePos += rayDir * dt;
        }
        if (alpha <= 1e-4) {
          discard;
        }
        gl_FragColor = vec4(rgb, alpha);
      }
    `
  });
}

function createSlicePreviewMaterial(texture: THREE.Data3DTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: {
      uDensityTex: { value: texture },
      uDensityGain: { value: 1.1 },
      uSliceAxis: { value: 2 },
      uSlicePosition: { value: 0.5 },
      uMistTimeSeconds: { value: 0 },
      uMistNoiseStrength: { value: 0.45 },
      uMistNoiseScale: { value: 1.6 },
      uMistNoiseSpeed: { value: 0.12 },
      uMistNoiseScroll: { value: new THREE.Vector3(0.03, 0.06, 0.02) },
      uMistNoiseContrast: { value: 0.9 },
      uMistNoiseBias: { value: 0.08 },
      uMistNoiseSeed: { value: 1 }
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp sampler3D;

      uniform sampler3D uDensityTex;
      uniform float uDensityGain;
      uniform int uSliceAxis;
      uniform float uSlicePosition;
      uniform float uMistTimeSeconds;
      uniform float uMistNoiseStrength;
      uniform float uMistNoiseScale;
      uniform float uMistNoiseSpeed;
      uniform vec3 uMistNoiseScroll;
      uniform float uMistNoiseContrast;
      uniform float uMistNoiseBias;
      uniform float uMistNoiseSeed;

      varying vec2 vUv;

      float hash31(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      vec3 grad3(vec3 cell) {
        float x = hash31(cell + vec3(11.3, 0.0, 0.0)) * 2.0 - 1.0;
        float y = hash31(cell + vec3(0.0, 17.1, 0.0)) * 2.0 - 1.0;
        float z = hash31(cell + vec3(0.0, 0.0, 23.7)) * 2.0 - 1.0;
        return normalize(vec3(x, y, z) + vec3(1e-4));
      }

      float gradientNoise3D(vec3 p) {
        vec3 cell = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        float n000 = dot(grad3(cell + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
        float n100 = dot(grad3(cell + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
        float n010 = dot(grad3(cell + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
        float n110 = dot(grad3(cell + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
        float n001 = dot(grad3(cell + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
        float n101 = dot(grad3(cell + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
        float n011 = dot(grad3(cell + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
        float n111 = dot(grad3(cell + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
        float nx00 = mix(n000, n100, u.x);
        float nx10 = mix(n010, n110, u.x);
        float nx01 = mix(n001, n101, u.x);
        float nx11 = mix(n011, n111, u.x);
        float nxy0 = mix(nx00, nx10, u.y);
        float nxy1 = mix(nx01, nx11, u.y);
        return mix(nxy0, nxy1, u.z);
      }

      float sampleLookupNoise(vec3 localPosition) {
        if (uMistNoiseStrength <= 1e-4) {
          return 1.0;
        }
        vec3 noisePosition =
          (localPosition + vec3(0.5) + uMistNoiseScroll * uMistTimeSeconds * uMistNoiseSpeed)
          * uMistNoiseScale
          + vec3(uMistNoiseSeed * 0.031);
        float noiseA = gradientNoise3D(noisePosition);
        float noiseB = gradientNoise3D(noisePosition * 2.03 + vec3(17.1, -9.4, 5.2));
        float noise = clamp(0.5 + 0.5 * (noiseA * 0.7 + noiseB * 0.3), 0.0, 1.0);
        float contrasted = clamp((noise - 0.5) * uMistNoiseContrast + 0.5 + uMistNoiseBias, 0.0, 1.0);
        return mix(1.0, contrasted, clamp(uMistNoiseStrength, 0.0, 1.0));
      }

      void main() {
        vec3 uvw = vec3(vUv, uSlicePosition);
        if (uSliceAxis == 0) {
          uvw = vec3(uSlicePosition, vUv.y, vUv.x);
        } else if (uSliceAxis == 1) {
          uvw = vec3(vUv.x, uSlicePosition, vUv.y);
        }
        float density = texture(uDensityTex, uvw).r;
        density *= sampleLookupNoise(uvw - vec3(0.5));
        float gray = clamp(density * uDensityGain, 0.0, 1.0);
        gl_FragColor = vec4(vec3(gray), 1.0);
      }
    `
  });
}

export class MistVolumeController {
  private readonly entriesByActorId = new Map<string, MistVolumeEntry>();

  public constructor(
    private readonly kernel: AppKernel,
    private readonly helpers: MistVolumeHelpers,
    private readonly qualityMode: MistVolumeQualityMode
  ) {}

  public setWebGlRenderer(_renderer: THREE.WebGLRenderer | null): void {
    // Mist is CPU-only for now; keep the renderer hook to avoid wider call-site churn.
  }

  public syncFromState(state: AppState, simTimeSeconds: number, dtSeconds: number): void {
    const actors = Object.values(state.actors).filter((actor) => actor.actorType === "mist-volume");
    const activeIds = new Set(actors.map((actor) => actor.id));
    for (const actorId of [...this.entriesByActorId.keys()]) {
      if (!activeIds.has(actorId)) {
        this.disposeEntry(actorId);
      }
    }
    for (const actor of actors) {
      this.syncActor(actor, state, simTimeSeconds, dtSeconds);
    }
  }

  public getResource(actorId: string): MistVolumeResource | null {
    const entry = this.entriesByActorId.get(actorId);
    const actor = this.helpers.getActorById(actorId);
    if (!entry || !actor) {
      return null;
    }
    const binding = this.resolveVolumeBinding(actor);
    if (!binding) {
      return null;
    }
    const lookupNoise = readLookupNoiseSettings(actor);
    return {
      densityTexture: this.getActiveDensityTexture(entry),
      worldToLocalElements: [...binding.worldToVolumeLocal.elements],
      resolution: [...entry.resolution] as [number, number, number],
      densityScale: 1,
      lookupNoiseStrength: lookupNoise.strength,
      lookupNoiseScale: lookupNoise.scale,
      lookupNoiseSpeed: lookupNoise.speed,
      lookupNoiseScroll: [lookupNoise.scroll.x, lookupNoise.scroll.y, lookupNoise.scroll.z],
      lookupNoiseContrast: lookupNoise.contrast,
      lookupNoiseBias: lookupNoise.bias,
      lookupNoiseSeed: lookupNoise.seed
    };
  }

  public dispose(): void {
    for (const actorId of [...this.entriesByActorId.keys()]) {
      this.disposeEntry(actorId);
    }
  }

  private syncActor(actor: ActorNode, state: AppState, simTimeSeconds: number, dtSeconds: number): void {
    const actorObject = this.helpers.getActorObject(actor.id);
    if (!(actorObject instanceof THREE.Object3D)) {
      return;
    }
    const quality = pickMistVolumeQuality(actor, this.qualityMode);
    const entry = this.ensureEntry(actor.id, quality.resolution);
    if (entry.previewGroup.parent !== actorObject) {
      actorObject.add(entry.previewGroup);
    }
    const updateStart = performance.now();
    const previewMode = readPreviewMode(actor.params.previewMode);
    const binding = this.resolveVolumeBinding(actor);
    const boundarySettings = readBoundarySettings(actor);
    if (!binding) {
      this.setPreviewVisibility(entry, false, previewMode);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          volumeActorName: "n/a",
          previewResolution: quality.resolution,
          qualityMode: quality.qualityMode,
          previewMode,
          activeSourceCount: 0,
          densityRange: this.computeDensityRange(entry.density),
          densityFadeRate: Number(readNumber(actor.params.densityDecay, 0.08, 0).toFixed(3)),
          outflowEnabled: Object.values(boundarySettings).some((mode) => mode === "open"),
          boundaryModes: buildBoundarySummary(boundarySettings),
          previewVisible: false,
          sourceCollectMs: 0,
          simulationMs: 0,
          uploadMs: 0,
          totalUpdateMs: roundMs(performance.now() - updateStart)
        },
        error: this.buildVolumeBindingError(actor),
        updatedAtIso: new Date().toISOString()
      });
      void state;
      return;
    }

    actorObject.updateWorldMatrix(true, false);
    this.updatePreviewTransform(entry, actorObject, binding.volumeMatrixWorld);
    this.updatePreviewUniforms(entry, actor, quality, binding, simTimeSeconds);
    const signature = JSON.stringify({
      manualResetToken: readNumber(actor.params.simulationResetToken, 0),
      volumeActorId: binding.actorId,
      volumeBinding: binding.resetSignature,
      resolution: quality.resolution,
      qualityMode: quality.qualityMode
    });
    const shouldReset =
      entry.lastSignature !== signature ||
      entry.lastSimTimeSeconds === null ||
      simTimeSeconds + 1e-6 < (entry.lastSimTimeSeconds ?? 0);
    if (shouldReset) {
      entry.density.fill(0);
      entry.densityScratch.fill(0);
      entry.velocity.fill(0);
      entry.velocityScratch.fill(0);
      entry.lastSignature = signature;
    }

    const sourceCollectStart = performance.now();
    const sources = this.collectSources(actor, binding);
    const sourceCollectMs = performance.now() - sourceCollectStart;
    const clampedDt = Math.max(0, Math.min(dtSeconds, 1 / 15));
    const simulationStart = performance.now();
    let cpuDiagnostics: MistCpuSimulationDiagnostics = { postInjectRange: "n/a", postTransportRange: "n/a", postFadeRange: "n/a" };
    if (clampedDt > 0) {
      cpuDiagnostics = this.simulate(entry, actor, sources, simTimeSeconds, clampedDt, quality);
    }
    const simulationMs = performance.now() - simulationStart;
    const uploadStart = performance.now();
    let uploadByteRange: [number, number] | "n/a" = "n/a";
    if (clampedDt > 0 || shouldReset) {
      uploadByteRange = this.uploadDensity(entry);
    }
    const uploadMs = performance.now() - uploadStart;
    entry.lastSimTimeSeconds = simTimeSeconds;

    const densityRange = this.computeDensityRange(entry.density);
    const previewVisible = this.setPreviewVisibility(entry, actorObject.visible === true, previewMode);
    const debugSettings = readDebugSettings(actor);
    const diagnosticSampleRange = this.computeDiagnosticSampleRange(entry, actor, simTimeSeconds);
    const debugState = this.updateDebugOverlay(
      entry,
      actor,
      binding,
      previewMode,
      readNumber(actor.params.slicePosition, 0.5, 0, 1),
      sources,
      simTimeSeconds,
      previewVisible
    );
    const noiseSeed = Math.floor(readNumber(actor.params.noiseSeed, 1));
    const emissionNoiseStrength = readNumber(actor.params.emissionNoiseStrength, 0, 0);
    const windNoiseStrength = readNumber(actor.params.windNoiseStrength, 0, 0);
    const wispiness = readNumber(actor.params.wispiness, 0, 0);
    const edgeBreakup = readNumber(actor.params.edgeBreakup, 0, 0);
    const lookupNoisePreset =
      typeof actor.params.lookupNoisePreset === "string" && actor.params.lookupNoisePreset.length > 0
        ? actor.params.lookupNoisePreset
        : "cloudy";
    const lookupNoise = readLookupNoiseSettings(actor);
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        volumeActorName: binding.actorName,
        previewResolution: quality.resolution,
        qualityMode: quality.qualityMode,
        simulationPausedMessage: clampedDt <= 1e-8 ? "Simulation time is paused (dt = 0). Press Play to advance the mist simulation." : null,
        previewMode,
        activeSourceCount: sources.length,
        firstSourceSample: this.buildSourceDiagnostic(sources),
        densityRange,
        densityFadeRate: Number(readNumber(actor.params.densityDecay, 0.08, 0).toFixed(3)),
        outflowEnabled: Object.values(boundarySettings).some((mode) => mode === "open"),
        cpuPostInjectRange: cpuDiagnostics.postInjectRange,
        cpuPostTransportRange: cpuDiagnostics.postTransportRange,
        cpuPostFadeRange: cpuDiagnostics.postFadeRange,
        uploadByteRange,
        diagnosticSampleRange,
        boundaryModes: buildBoundarySummary(boundarySettings),
        previewVisible,
        debugOverlayMode: debugSettings.overlayMode,
        debugGridResolution: [debugSettings.gridResolution.x, debugSettings.gridResolution.y, debugSettings.gridResolution.z],
        debugDensitySampleRange: debugState.sampleRange,
        debugSourceMarkerCount: debugState.sourceMarkerCount,
        noiseSeed,
        emissionNoiseActive: emissionNoiseStrength > 1e-4,
        windNoiseActive: windNoiseStrength > 1e-4,
        wispiness: Number(wispiness.toFixed(3)),
        edgeBreakup: Number(edgeBreakup.toFixed(3)),
        lookupNoisePreset,
        lookupNoiseActive: lookupNoise.strength > 1e-4,
        sourceCollectMs: roundMs(sourceCollectMs),
        simulationMs: roundMs(simulationMs),
        uploadMs: roundMs(uploadMs),
        totalUpdateMs: roundMs(performance.now() - updateStart)
      },
      updatedAtIso: new Date().toISOString()
    });
    void state;
  }

  private ensureEntry(actorId: string, resolution: [number, number, number]): MistVolumeEntry {
    const existing = this.entriesByActorId.get(actorId);
    if (existing && existing.resolution[0] === resolution[0] && existing.resolution[1] === resolution[1] && existing.resolution[2] === resolution[2]) {
      return existing;
    }
    if (existing) {
      this.disposeEntry(actorId);
    }
    const count = resolution[0] * resolution[1] * resolution[2];
    const uploadBytes = new Uint8Array(count);
    const texture = new THREE.Data3DTexture(uploadBytes, resolution[0], resolution[1], resolution[2]);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    const volumeMaterial = createVolumePreviewMaterial(texture);
    const sliceMaterial = createSlicePreviewMaterial(texture);
    const boundsMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color("#d9eef7"),
      transparent: true,
      opacity: 0.9
    });
    const volumeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), volumeMaterial);
    volumeMesh.frustumCulled = false;
    volumeMesh.name = "mist-volume-preview-volume";
    const boundsMesh = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), boundsMaterial);
    boundsMesh.frustumCulled = false;
    boundsMesh.name = "mist-volume-preview-bounds";
    const sliceMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sliceMaterial);
    sliceMesh.frustumCulled = false;
    sliceMesh.name = "mist-volume-preview-slice";
    const debugGroup = new THREE.Group();
    debugGroup.name = "mist-volume-debug";
    const debugLabelGroup = new THREE.Group();
    debugLabelGroup.name = "mist-volume-debug-labels";
    const debugDensityPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: 0.06,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false
      })
    );
    debugDensityPoints.frustumCulled = false;
    debugDensityPoints.name = "mist-volume-debug-density";
    const debugVelocityLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#ffcc55"),
        transparent: true,
        opacity: 0.9,
        depthWrite: false
      })
    );
    debugVelocityLines.frustumCulled = false;
    debugVelocityLines.name = "mist-volume-debug-velocity";
    const debugSourceLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#7ce0ff"),
        transparent: true,
        opacity: 0.95,
        depthWrite: false
      })
    );
    debugSourceLines.frustumCulled = false;
    debugSourceLines.name = "mist-volume-debug-sources";
    debugGroup.add(debugLabelGroup, debugDensityPoints, debugVelocityLines, debugSourceLines);
    const previewGroup = new THREE.Group();
    previewGroup.name = "mist-volume-preview";
    previewGroup.matrixAutoUpdate = false;
    previewGroup.add(volumeMesh, boundsMesh, sliceMesh, debugGroup);
    const entry: MistVolumeEntry = {
      actorId,
      previewGroup,
      debugGroup,
      debugLabelGroup,
      debugDensityPoints,
      debugVelocityLines,
      debugSourceLines,
      volumeMesh,
      boundsMesh,
      sliceMesh,
      volumeMaterial,
      sliceMaterial,
      boundsMaterial,
      cpuTexture: texture,
      uploadBytes,
      density: new Float32Array(count),
      densityScratch: new Float32Array(count),
      velocity: new Float32Array(count * 3),
      velocityScratch: new Float32Array(count * 3),
      count,
      resolution: [...resolution] as [number, number, number],
      lastSignature: "",
      lastSimTimeSeconds: null,
      lastLocalCameraInside: false,
      debugLabelPlaneGeometry: new THREE.PlaneGeometry(1, 1),
      debugLabelTextureCache: new Map()
    };
    this.entriesByActorId.set(actorId, entry);
    return entry;
  }

  private getActiveDensityTexture(entry: MistVolumeEntry): THREE.Data3DTexture {
    return entry.cpuTexture;
  }

  private resolveVolumeBinding(actor: ActorNode): MistVolumeBinding | null {
    const volumeActorId = typeof actor.params.volumeActorId === "string" && actor.params.volumeActorId.length > 0 ? actor.params.volumeActorId : null;
    if (!volumeActorId) {
      return null;
    }
    const volumeActor = this.helpers.getActorById(volumeActorId);
    const volumeObject = this.helpers.getActorObject(volumeActorId);
    if (!volumeActor || !(volumeObject instanceof THREE.Object3D) || volumeActor.actorType !== "primitive" || volumeActor.params.shape !== "cube") {
      return null;
    }
    volumeObject.updateWorldMatrix(true, false);
    const cubeSize = Math.max(0.001, readNumber(volumeActor.params.cubeSize, 1, 0.001));
    const volumeMatrixWorld = volumeObject.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(cubeSize, cubeSize, cubeSize));
    return {
      actorId: volumeActor.id,
      actorName: volumeActor.name,
      cubeSize,
      volumeMatrixWorld,
      worldToVolumeLocal: volumeMatrixWorld.clone().invert(),
      resetSignature: JSON.stringify({
        cubeSize,
        matrix: matrixSignature(volumeMatrixWorld)
      })
    };
  }

  private buildVolumeBindingError(actor: ActorNode): string {
    const volumeActorId = typeof actor.params.volumeActorId === "string" && actor.params.volumeActorId.length > 0 ? actor.params.volumeActorId : null;
    if (!volumeActorId) {
      return "Assign a cube primitive actor to Volume Cube.";
    }
    const volumeActor = this.helpers.getActorById(volumeActorId);
    if (!volumeActor) {
      return "The referenced Volume Cube actor could not be found.";
    }
    if (volumeActor.actorType !== "primitive") {
      return "Volume Cube must reference a primitive actor.";
    }
    if (volumeActor.params.shape !== "cube") {
      return "Volume Cube must reference a primitive actor with Shape set to cube.";
    }
    return "The referenced Volume Cube actor is not available for simulation.";
  }

  private updatePreviewTransform(entry: MistVolumeEntry, actorObject: THREE.Object3D, volumeMatrixWorld: THREE.Matrix4): void {
    const previewLocalMatrix = actorObject.matrixWorld.clone().invert().multiply(volumeMatrixWorld);
    entry.previewGroup.matrix.copy(previewLocalMatrix);
    entry.previewGroup.matrixWorldNeedsUpdate = true;
  }

  private updatePreviewUniforms(
    entry: MistVolumeEntry,
    actor: ActorNode,
    quality: MistVolumeQualitySettings,
    binding: MistVolumeBinding,
    simTimeSeconds: number
  ): void {
    const previewTint = readColor(actor.params.previewTint, "#d9eef7");
    const previewMode = readPreviewMode(actor.params.previewMode);
    const slicePosition = readNumber(actor.params.slicePosition, 0.5, 0, 1);
    const lookupNoise = readLookupNoiseSettings(actor);
    const cameraPosition = this.kernel.store.getState().state.camera.position;
    const volumeUniforms = entry.volumeMaterial.uniforms as {
      uDensityTex: { value: THREE.Data3DTexture };
      uPreviewTint: { value: THREE.Color };
      uOpacityScale: { value: number };
      uDensityThreshold: { value: number };
      uRaymarchSteps: { value: number };
      uWorldToLocal: { value: THREE.Matrix4 };
      uMistTimeSeconds: { value: number };
      uMistNoiseStrength: { value: number };
      uMistNoiseScale: { value: number };
      uMistNoiseSpeed: { value: number };
      uMistNoiseScroll: { value: THREE.Vector3 };
      uMistNoiseContrast: { value: number };
      uMistNoiseBias: { value: number };
      uMistNoiseSeed: { value: number };
    };
    volumeUniforms.uDensityTex.value = this.getActiveDensityTexture(entry);
    volumeUniforms.uPreviewTint.value.copy(previewTint);
    volumeUniforms.uOpacityScale.value = readNumber(actor.params.previewOpacity, 1.1, 0, 4);
    volumeUniforms.uDensityThreshold.value = readNumber(actor.params.previewThreshold, 0.02, 0, 1);
    volumeUniforms.uRaymarchSteps.value = quality.previewRaymarchSteps;
    volumeUniforms.uWorldToLocal.value.copy(binding.worldToVolumeLocal);
    volumeUniforms.uMistTimeSeconds.value = simTimeSeconds;
    volumeUniforms.uMistNoiseStrength.value = lookupNoise.strength;
    volumeUniforms.uMistNoiseScale.value = lookupNoise.scale;
    volumeUniforms.uMistNoiseSpeed.value = lookupNoise.speed;
    volumeUniforms.uMistNoiseScroll.value.copy(lookupNoise.scroll);
    volumeUniforms.uMistNoiseContrast.value = lookupNoise.contrast;
    volumeUniforms.uMistNoiseBias.value = lookupNoise.bias;
    volumeUniforms.uMistNoiseSeed.value = lookupNoise.seed;
    const sliceUniforms = entry.sliceMaterial.uniforms as {
      uDensityTex: { value: THREE.Data3DTexture };
      uDensityGain: { value: number };
      uSliceAxis: { value: number };
      uSlicePosition: { value: number };
      uMistTimeSeconds: { value: number };
      uMistNoiseStrength: { value: number };
      uMistNoiseScale: { value: number };
      uMistNoiseSpeed: { value: number };
      uMistNoiseScroll: { value: THREE.Vector3 };
      uMistNoiseContrast: { value: number };
      uMistNoiseBias: { value: number };
      uMistNoiseSeed: { value: number };
    };
    sliceUniforms.uDensityTex.value = this.getActiveDensityTexture(entry);
    sliceUniforms.uDensityGain.value = readNumber(actor.params.previewOpacity, 1.1, 0, 8);
    sliceUniforms.uSliceAxis.value = previewMode === "slice-x" ? 0 : previewMode === "slice-y" ? 1 : 2;
    sliceUniforms.uSlicePosition.value = slicePosition;
    sliceUniforms.uMistTimeSeconds.value = simTimeSeconds;
    sliceUniforms.uMistNoiseStrength.value = lookupNoise.strength;
    sliceUniforms.uMistNoiseScale.value = lookupNoise.scale;
    sliceUniforms.uMistNoiseSpeed.value = lookupNoise.speed;
    sliceUniforms.uMistNoiseScroll.value.copy(lookupNoise.scroll);
    sliceUniforms.uMistNoiseContrast.value = lookupNoise.contrast;
    sliceUniforms.uMistNoiseBias.value = lookupNoise.bias;
    sliceUniforms.uMistNoiseSeed.value = lookupNoise.seed;
    entry.boundsMaterial.color.copy(previewTint);
    const localCameraPosition = new THREE.Vector3(
      cameraPosition[0] ?? 0,
      cameraPosition[1] ?? 0,
      cameraPosition[2] ?? 0
    ).applyMatrix4(binding.worldToVolumeLocal);
    entry.lastLocalCameraInside = isLocalCameraInsideUnitCube(localCameraPosition);
    entry.volumeMaterial.side = entry.lastLocalCameraInside ? THREE.BackSide : THREE.FrontSide;
    entry.sliceMesh.position.set(0, 0, 0);
    entry.sliceMesh.rotation.set(0, 0, 0);
    if (previewMode === "slice-x") {
      entry.sliceMesh.position.x = slicePosition - 0.5;
      entry.sliceMesh.rotation.y = Math.PI / 2;
    } else if (previewMode === "slice-y") {
      entry.sliceMesh.position.y = slicePosition - 0.5;
      entry.sliceMesh.rotation.x = -Math.PI / 2;
    } else if (previewMode === "slice-z") {
      entry.sliceMesh.position.z = slicePosition - 0.5;
    }
  }

  private setPreviewVisibility(entry: MistVolumeEntry, actorVisible: boolean, previewMode: MistPreviewMode): boolean {
    const showVolume = actorVisible && previewMode === "volume";
    const showBounds = actorVisible && previewMode === "bounds";
    const showSlice = actorVisible && (previewMode === "slice-x" || previewMode === "slice-y" || previewMode === "slice-z");
    entry.previewGroup.visible = actorVisible && previewMode !== "off";
    entry.volumeMesh.visible = showVolume;
    entry.boundsMesh.visible = showBounds;
    entry.sliceMesh.visible = showSlice;
    return showVolume || showBounds || showSlice;
  }

  private buildDebugSamplePoints(
    previewMode: MistPreviewMode,
    gridResolution: MistDebugGridResolution,
    slicePosition: number
  ): MistDebugSamplePoint[] {
    const points: MistDebugSamplePoint[] = [];
    const range = (count: number) => Array.from({ length: count }, (_, index) => count <= 1 ? 0 : index / (count - 1) - 0.5);
    if (previewMode === "slice-x") {
      for (const y of range(gridResolution.y)) {
        for (const z of range(gridResolution.z)) {
          points.push({
            localPosition: new THREE.Vector3(slicePosition - 0.5, y, z)
          });
        }
      }
      return points;
    }
    if (previewMode === "slice-y") {
      for (const x of range(gridResolution.x)) {
        for (const z of range(gridResolution.z)) {
          points.push({
            localPosition: new THREE.Vector3(x, slicePosition - 0.5, z)
          });
        }
      }
      return points;
    }
    if (previewMode === "slice-z") {
      for (const x of range(gridResolution.x)) {
        for (const y of range(gridResolution.y)) {
          points.push({
            localPosition: new THREE.Vector3(x, y, slicePosition - 0.5)
          });
        }
      }
      return points;
    }
    for (const z of range(gridResolution.z)) {
      for (const y of range(gridResolution.y)) {
        for (const x of range(gridResolution.x)) {
          points.push({
            localPosition: new THREE.Vector3(x, y, z)
          });
        }
      }
    }
    return points;
  }

  private sampleCpuDebugResult(
    entry: MistVolumeEntry,
    actor: ActorNode,
    localPosition: THREE.Vector3,
    simTimeSeconds: number
  ): MistDebugSampleResult {
    const resolution = entry.resolution;
    const uvw = localPosition.clone().addScalar(0.5);
    const rawDensity = sampleTrilinear(
      entry.density,
      resolution,
      uvw.x * (resolution[0] - 1),
      uvw.y * (resolution[1] - 1),
      uvw.z * (resolution[2] - 1)
    );
    const density = clamp01(rawDensity * this.sampleLookupNoiseCpu(actor, localPosition, simTimeSeconds));
    const velocity = new THREE.Vector3(
      sampleVelocityComponentTrilinear(entry.velocity, resolution, 0, uvw.x * (resolution[0] - 1), uvw.y * (resolution[1] - 1), uvw.z * (resolution[2] - 1)),
      sampleVelocityComponentTrilinear(entry.velocity, resolution, 1, uvw.x * (resolution[0] - 1), uvw.y * (resolution[1] - 1), uvw.z * (resolution[2] - 1)),
      sampleVelocityComponentTrilinear(entry.velocity, resolution, 2, uvw.x * (resolution[0] - 1), uvw.y * (resolution[1] - 1), uvw.z * (resolution[2] - 1))
    );
    return { density, rawDensity, velocity };
  }

  private sampleLookupNoiseCpu(actor: ActorNode, localPosition: THREE.Vector3, simTimeSeconds: number): number {
    const lookupNoise = readLookupNoiseSettings(actor);
    if (lookupNoise.strength <= 1e-4) {
      return 1;
    }
    const noisePosition = localPosition.clone()
      .addScalar(0.5)
      .add(lookupNoise.scroll.clone().multiplyScalar(simTimeSeconds * lookupNoise.speed))
      .multiplyScalar(lookupNoise.scale)
      .addScalar(lookupNoise.seed * 0.031);
    const noiseA = sampleScalarNoiseFromLocalPosition(noisePosition.x, noisePosition.y, noisePosition.z, 0, lookupNoise.seed, 1, 1) * 2 - 1;
    const noiseB = sampleScalarNoiseFromLocalPosition(noisePosition.x * 2.03 + 17.1, noisePosition.y * 2.03 - 9.4, noisePosition.z * 2.03 + 5.2, 0, lookupNoise.seed + 17, 1, 1) * 2 - 1;
    const noise = clamp01(0.5 + 0.5 * (noiseA * 0.7 + noiseB * 0.3));
    const contrasted = clamp01((noise - 0.5) * lookupNoise.contrast + 0.5 + lookupNoise.bias);
    return THREE.MathUtils.lerp(1, contrasted, clamp01(lookupNoise.strength));
  }

  private sampleDebugResults(
    entry: MistVolumeEntry,
    actor: ActorNode,
    simTimeSeconds: number,
    samplePoints: MistDebugSamplePoint[]
  ): MistDebugSampleResult[] {
    if (samplePoints.length === 0) {
      return [];
    }
    return samplePoints.map((point) => this.sampleCpuDebugResult(entry, actor, point.localPosition, simTimeSeconds));
  }

  private computeDiagnosticSampleRange(entry: MistVolumeEntry, actor: ActorNode, simTimeSeconds: number): [number, number] | "n/a" {
    const samplePoints = this.buildDebugSamplePoints("volume", { x: 4, y: 4, z: 4 }, 0.5);
    const sampleResults = this.sampleDebugResults(entry, actor, simTimeSeconds, samplePoints);
    if (sampleResults.length === 0) {
      return "n/a";
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const result of sampleResults) {
      min = Math.min(min, result.density);
      max = Math.max(max, result.density);
    }
    return [Number(min.toFixed(3)), Number(max.toFixed(3))];
  }

  private buildSourceDiagnostic(sources: MistVolumeSourceSample[]): string {
    const firstSource = sources[0];
    if (!firstSource) {
      return "n/a";
    }
    const format = (value: number) => Number(value.toFixed(3));
    return `pos ${format(firstSource.positionLocal.x)}, ${format(firstSource.positionLocal.y)}, ${format(firstSource.positionLocal.z)} | dir ${format(firstSource.directionLocal.x)}, ${format(firstSource.directionLocal.y)}, ${format(firstSource.directionLocal.z)}`;
  }

  private getOrCreateDebugLabelTexture(
    entry: MistVolumeEntry,
    label: string
  ): { texture: THREE.CanvasTexture; aspect: number } {
    const cached = entry.debugLabelTextureCache.get(label);
    if (cached) {
      return cached;
    }
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");
    const fontSize = 96;
    const font = `bold ${fontSize}px monospace`;
    const horizontalPadding = 28;
    const verticalPadding = 16;
    const border = 3;
    const measuredWidth = (() => {
      if (!measureContext) {
        return fontSize * Math.max(1, label.length) * 0.62;
      }
      measureContext.font = font;
      return Math.max(1, measureContext.measureText(label).width);
    })();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(measuredWidth + horizontalPadding * 2 + border * 2);
    canvas.height = Math.ceil(fontSize + verticalPadding * 2 + border * 2);
    const context = canvas.getContext("2d");
    if (!context) {
      const texture = new THREE.CanvasTexture(canvas);
      const fallback = { texture, aspect: canvas.width / Math.max(1, canvas.height) };
      entry.debugLabelTextureCache.set(label, fallback);
      return fallback;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(8, 10, 16, 0.88)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "rgba(220, 240, 255, 0.9)";
    context.lineWidth = border;
    context.strokeRect(border / 2, border / 2, canvas.width - border, canvas.height - border);
    context.fillStyle = "#ffffff";
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    const next = {
      texture,
      aspect: canvas.width / Math.max(1, canvas.height)
    };
    entry.debugLabelTextureCache.set(label, next);
    return next;
  }

  private updateDebugOverlay(
    entry: MistVolumeEntry,
    actor: ActorNode,
    binding: MistVolumeBinding,
    previewMode: MistPreviewMode,
    slicePosition: number,
    sources: MistVolumeSourceSample[],
    simTimeSeconds: number,
    previewVisible: boolean
  ): { sampleRange: [number, number] | "n/a"; sourceMarkerCount: number } {
    const debugSettings = readDebugSettings(actor);
    const showPrimaryOverlay = previewVisible && debugSettings.overlayMode !== "off";
    const showSourceMarkers = previewVisible && debugSettings.sourceMarkers;
    entry.debugGroup.visible = showPrimaryOverlay || showSourceMarkers;
    entry.debugLabelGroup.visible = showPrimaryOverlay && debugSettings.overlayMode === "numbers";
    entry.debugDensityPoints.visible = showPrimaryOverlay && debugSettings.overlayMode === "density-cells";
    entry.debugVelocityLines.visible = showPrimaryOverlay && debugSettings.overlayMode === "velocity-vectors";
    entry.debugSourceLines.visible = showSourceMarkers;
    let sampleRange: [number, number] | "n/a" = "n/a";
    if (showPrimaryOverlay) {
      const samplePoints = this.buildDebugSamplePoints(previewMode, debugSettings.gridResolution, slicePosition);
      const sampleResults = this.sampleDebugResults(
        entry,
        actor,
        simTimeSeconds,
        samplePoints
      );
      if (sampleResults.length > 0) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const result of sampleResults) {
          min = Math.min(min, result.density);
          max = Math.max(max, result.density);
        }
        sampleRange = [Number(min.toFixed(3)), Number(max.toFixed(3))];
      }
      this.rebuildDebugLabels(
        entry,
        binding,
        samplePoints,
        sampleResults,
        debugSettings.valueSize,
        debugSettings.hideZeroNumbers,
        debugSettings.densityThreshold
      );
      this.rebuildDebugDensityPoints(entry, samplePoints, sampleResults, debugSettings);
      this.rebuildDebugVelocityLines(entry, samplePoints, sampleResults, debugSettings);
    } else {
      this.rebuildDebugLabels(
        entry,
        binding,
        [],
        [],
        debugSettings.valueSize,
        debugSettings.hideZeroNumbers,
        debugSettings.densityThreshold
      );
      this.rebuildDebugDensityPoints(entry, [], [], debugSettings);
      this.rebuildDebugVelocityLines(entry, [], [], debugSettings);
    }
    const sourceMarkerCount = showSourceMarkers ? this.rebuildDebugSourceMarkers(entry, sources) : this.rebuildDebugSourceMarkers(entry, []);
    return { sampleRange, sourceMarkerCount };
  }

  private getDebugLabelQuaternion(binding: MistVolumeBinding): THREE.Quaternion {
    const cameraPosition = this.kernel.store.getState().state.camera.position;
    const localCameraPosition = new THREE.Vector3(
      cameraPosition[0] ?? 0,
      cameraPosition[1] ?? 0,
      cameraPosition[2] ?? 0
    ).applyMatrix4(binding.worldToVolumeLocal);
    const faceNormal = new THREE.Vector3(0, 0, 1);
    const absX = Math.abs(localCameraPosition.x);
    const absY = Math.abs(localCameraPosition.y);
    const absZ = Math.abs(localCameraPosition.z);
    if (absX >= absY && absX >= absZ) {
      faceNormal.set(Math.sign(localCameraPosition.x) || 1, 0, 0);
    } else if (absY >= absZ) {
      faceNormal.set(0, Math.sign(localCameraPosition.y) || 1, 0);
    } else {
      faceNormal.set(0, 0, Math.sign(localCameraPosition.z) || 1);
    }
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), faceNormal);
  }

  private rebuildDebugLabels(
    entry: MistVolumeEntry,
    binding: MistVolumeBinding,
    samplePoints: MistDebugSamplePoint[],
    sampleResults: MistDebugSampleResult[],
    valueSize: number,
    hideZeroNumbers: boolean,
    densityThreshold: number
  ): void {
    for (const child of [...entry.debugLabelGroup.children]) {
      entry.debugLabelGroup.remove(child);
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        child.material.dispose();
      }
    }
    const labelQuaternion = this.getDebugLabelQuaternion(binding);
    samplePoints.forEach((samplePoint, index) => {
      const density = sampleResults[index]?.rawDensity ?? sampleResults[index]?.density ?? 0;
      if (hideZeroNumbers && density < densityThreshold) {
        return;
      }
      const labelTexture = this.getOrCreateDebugLabelTexture(entry, density.toPrecision(3));
      const material = new THREE.MeshBasicMaterial({
        map: labelTexture.texture,
        transparent: true,
        depthWrite: false,
        depthTest: false
      });
      const mesh = new THREE.Mesh(entry.debugLabelPlaneGeometry, material);
      mesh.position.copy(samplePoint.localPosition);
      mesh.quaternion.copy(labelQuaternion);
      mesh.scale.set(valueSize * labelTexture.aspect, valueSize, 1);
      mesh.frustumCulled = false;
      entry.debugLabelGroup.add(mesh);
    });
  }

  private rebuildDebugDensityPoints(
    entry: MistVolumeEntry,
    samplePoints: MistDebugSamplePoint[],
    sampleResults: MistDebugSampleResult[],
    debugSettings: MistDebugSettings
  ): void {
    const positions: number[] = [];
    const colors: number[] = [];
    samplePoints.forEach((samplePoint, index) => {
      const density = sampleResults[index]?.density ?? 0;
      if (density < debugSettings.densityThreshold) {
        return;
      }
      positions.push(samplePoint.localPosition.x, samplePoint.localPosition.y, samplePoint.localPosition.z);
      colors.push(density, density, density);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    entry.debugDensityPoints.geometry.dispose();
    entry.debugDensityPoints.geometry = geometry;
    (entry.debugDensityPoints.material as THREE.PointsMaterial).size = debugSettings.valueSize * 0.9;
  }

  private rebuildDebugVelocityLines(
    entry: MistVolumeEntry,
    samplePoints: MistDebugSamplePoint[],
    sampleResults: MistDebugSampleResult[],
    debugSettings: MistDebugSettings
  ): void {
    const positions: number[] = [];
    samplePoints.forEach((samplePoint, index) => {
      const velocity = sampleResults[index]?.velocity ?? new THREE.Vector3();
      if (velocity.lengthSq() <= 1e-8) {
        return;
      }
      const end = samplePoint.localPosition.clone().add(velocity.clone().multiplyScalar(debugSettings.vectorScale));
      positions.push(
        samplePoint.localPosition.x, samplePoint.localPosition.y, samplePoint.localPosition.z,
        end.x, end.y, end.z
      );
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    entry.debugVelocityLines.geometry.dispose();
    entry.debugVelocityLines.geometry = geometry;
  }

  private rebuildDebugSourceMarkers(entry: MistVolumeEntry, sources: MistVolumeSourceSample[]): number {
    const positions: number[] = [];
    for (const source of sources) {
      const end = source.positionLocal.clone().add(source.directionLocal.clone().multiplyScalar(0.08));
      positions.push(
        source.positionLocal.x, source.positionLocal.y, source.positionLocal.z,
        end.x, end.y, end.z
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    entry.debugSourceLines.geometry.dispose();
    entry.debugSourceLines.geometry = geometry;
    return sources.length;
  }

  private collectSources(actor: ActorNode, binding: MistVolumeBinding): MistVolumeSourceSample[] {
    const worldToLocal = binding.worldToVolumeLocal;
    const emissionDirection = readVector3(actor.params.emissionDirection, [0, -1, 0]);
    if (emissionDirection.lengthSq() <= 1e-8) {
      emissionDirection.set(0, -1, 0);
    }
    emissionDirection.normalize();
    const sourceActorIds = parseActorIdList(actor.params.sourceActorIds);
    const samples: MistVolumeSourceSample[] = [];
    const worldPosition = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    for (const sourceActorId of sourceActorIds) {
      const sourceActor = this.helpers.getActorById(sourceActorId);
      const sourceObject = this.helpers.getActorObject(sourceActorId);
      if (!sourceActor || sourceActor.enabled === false || !(sourceObject instanceof THREE.Object3D)) {
        continue;
      }
      sourceObject.updateWorldMatrix(true, false);
      sourceObject.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
      const directionWorld = emissionDirection.clone().applyQuaternion(worldQuaternion).normalize();
      if (sourceActor.actorType === "empty") {
        samples.push({
          positionLocal: new THREE.Vector3().setFromMatrixPosition(sourceObject.matrixWorld).applyMatrix4(worldToLocal),
          directionLocal: directionWorld.clone().transformDirection(worldToLocal).normalize(),
          strength: 1
        });
        continue;
      }
      if (sourceActor.actorType === "plugin") {
        const resource = this.helpers.getVolumetricRayResource(sourceActor.id);
        samples.push(...collectMistSourcesFromVolumetricRayResource(resource, worldToLocal));
        continue;
      }
      if (sourceActor.actorType !== "curve") {
        continue;
      }
      const curveData = curveDataWithOverrides(sourceActor);
      const pointCount = curveData.kind === "circle" ? 1 : curveData.points.filter((point) => point.enabled !== false).length;
      const segmentCount = curveData.kind === "circle" ? 1 : pointCount < 2 ? 0 : (curveData.closed ? pointCount : pointCount - 1);
      const sampleCount = Math.max(2, getCurveSamplesPerSegmentFromActor(sourceActor) * Math.max(1, segmentCount));
      for (let index = 0; index < sampleCount; index += 1) {
        const t = sampleCount <= 1 ? 0 : index / Math.max(1, sampleCount - 1);
        const sampled = this.helpers.sampleCurveWorldPoint(sourceActor.id, curveData.closed ? t : Math.min(t, 0.999999));
        if (!sampled) {
          continue;
        }
        samples.push({
          positionLocal: new THREE.Vector3(...sampled.position).applyMatrix4(worldToLocal),
          directionLocal: directionWorld.clone().transformDirection(worldToLocal).normalize(),
          strength: 1
        });
      }
    }
    return samples;
  }

  private simulate(
    entry: MistVolumeEntry,
    actor: ActorNode,
    sources: MistVolumeSourceSample[],
    simTimeSeconds: number,
    dtSeconds: number,
    quality: MistVolumeQualitySettings
  ): MistCpuSimulationDiagnostics {
    const steps = Math.max(1, quality.simulationSubsteps);
    const stepDt = dtSeconds / steps;
    const noiseSeed = Math.floor(readNumber(actor.params.noiseSeed, 1));
    const sourceRadius = Math.max(0.01, readNumber(actor.params.sourceRadius, 0.2, 0.01));
    const injectionRate = Math.max(0, readNumber(actor.params.injectionRate, 1, 0));
    const initialSpeed = Math.max(0, readNumber(actor.params.initialSpeed, 0.6, 0));
    const buoyancy = readNumber(actor.params.buoyancy, 0.35);
    const velocityDrag = clamp01(readNumber(actor.params.velocityDrag, 0.12, 0, 1));
    const diffusion = Math.max(0, readNumber(actor.params.diffusion, 0.04, 0));
    const densityDecay = Math.max(0, readNumber(actor.params.densityDecay, 0.08, 0));
    const emissionNoiseStrength = readNumber(actor.params.emissionNoiseStrength, 0, 0);
    const emissionNoiseScale = readNumber(actor.params.emissionNoiseScale, 1, 0.01);
    const emissionNoiseSpeed = readNumber(actor.params.emissionNoiseSpeed, 0.75, 0);
    const windVector = readVector3(actor.params.windVector, [0, 0, 0]);
    const windNoiseStrength = readNumber(actor.params.windNoiseStrength, 0, 0);
    const windNoiseScale = readNumber(actor.params.windNoiseScale, 0.75, 0.01);
    const windNoiseSpeed = readNumber(actor.params.windNoiseSpeed, 0.25, 0);
    const wispiness = readNumber(actor.params.wispiness, 0, 0);
    const edgeBreakup = readNumber(actor.params.edgeBreakup, 0, 0);
    const boundaries = readBoundarySettings(actor);
    const closedBoundaries: MistBoundarySettings = {
      negX: "closed",
      posX: "closed",
      negY: "closed",
      posY: "closed",
      negZ: "closed",
      posZ: "closed"
    };
    const radiusCells = Math.max(
      1,
      Math.ceil(
        sourceRadius *
        Math.max(entry.resolution[0], entry.resolution[1], entry.resolution[2])
      )
      );
    let postInjectRange: [number, number] | "n/a" = "n/a";
    let postTransportRange: [number, number] | "n/a" = "n/a";

    for (let step = 0; step < steps; step += 1) {
      const stepTime = simTimeSeconds - dtSeconds + stepDt * (step + 1);
      this.injectSources(
        entry,
        sources,
        radiusCells,
        injectionRate * stepDt,
        initialSpeed,
        stepTime,
        noiseSeed,
        emissionNoiseStrength,
        emissionNoiseScale,
        emissionNoiseSpeed
      );
      postInjectRange = computeMistDensityRange(entry.density);
      const postInjectTotalDensity = sumMistDensityForTest(entry.density);
      const densityBeforeTransport = entry.density.slice();
      const closedTransportDensity = entry.density.slice();
      const closedTransportScratch = new Float32Array(entry.count);
      this.applyNoiseForces(entry, stepDt, stepTime, noiseSeed, windVector, windNoiseStrength, windNoiseScale, windNoiseSpeed, wispiness);
      this.diffuseVelocity(entry, diffusion, stepDt);
      transportMistDensityForTest(closedTransportDensity, closedTransportScratch, entry.velocity, entry.resolution, stepDt, closedBoundaries, diffusion);
      entry.density.set(densityBeforeTransport);
      this.advectDensity(entry, stepDt, boundaries);
      this.applyDensityDiffusion(entry, diffusion);
      const legitimateOutflow = Math.max(0, sumMistDensityForTest(closedTransportDensity) - sumMistDensityForTest(entry.density));
      preserveMistDensityMassForBoundaries(entry.density, Math.max(0, postInjectTotalDensity - legitimateOutflow));
      postTransportRange = computeMistDensityRange(entry.density);
      this.applyDecay(entry, densityDecay, stepDt, edgeBreakup, stepTime, noiseSeed);
      this.applyVelocityForces(entry, buoyancy, velocityDrag, stepDt, boundaries);
    }
    return {
      postInjectRange,
      postTransportRange,
      postFadeRange: computeMistDensityRange(entry.density)
    };
  }

  private injectSources(
    entry: MistVolumeEntry,
    sources: MistVolumeSourceSample[],
    radiusCells: number,
    densityGain: number,
    initialSpeed: number,
    timeSeconds: number,
    noiseSeed: number,
    emissionNoiseStrength: number,
    emissionNoiseScale: number,
    emissionNoiseSpeed: number
  ): void {
    injectMistSourcesIntoField(
      entry.density,
      entry.velocity,
      entry.resolution,
      sources,
      radiusCells,
      densityGain,
      initialSpeed,
      timeSeconds,
      noiseSeed,
      emissionNoiseStrength,
      emissionNoiseScale,
      emissionNoiseSpeed
    );
  }

  private applyNoiseForces(
    entry: MistVolumeEntry,
    stepDt: number,
    timeSeconds: number,
    noiseSeed: number,
    windVector: THREE.Vector3,
    windNoiseStrength: number,
    windNoiseScale: number,
    windNoiseSpeed: number,
    wispiness: number
  ): void {
    applyMistNoiseForcesForTest(
      entry.density,
      entry.velocity,
      entry.resolution,
      stepDt,
      timeSeconds,
      noiseSeed,
      windVector,
      windNoiseStrength,
      windNoiseScale,
      windNoiseSpeed,
      wispiness
    );
  }

  private diffuseVelocity(entry: MistVolumeEntry, diffusion: number, stepDt: number): void {
    diffuseMistVelocityForTest(entry.velocity, entry.velocityScratch, entry.resolution, diffusion, stepDt);
  }

  private advectDensity(entry: MistVolumeEntry, stepDt: number, boundaries: MistBoundarySettings): void {
    advectMistDensityForTest(entry.density, entry.densityScratch, entry.velocity, entry.resolution, stepDt, boundaries);
  }

  private applyDensityDiffusion(entry: MistVolumeEntry, diffusion: number): void {
    applyMistDensityDiffusionForTest(entry.density, entry.densityScratch, entry.resolution, diffusion);
  }

  private applyDecay(
    entry: MistVolumeEntry,
    densityDecay: number,
    stepDt: number,
    edgeBreakup: number,
    timeSeconds: number,
    noiseSeed: number
  ): void {
    applyMistDensityDecayForTest(entry.density, entry.resolution, densityDecay, stepDt, edgeBreakup, timeSeconds, noiseSeed);
  }

  private applyVelocityForces(
    entry: MistVolumeEntry,
    buoyancy: number,
    velocityDrag: number,
    stepDt: number,
    boundaries: MistBoundarySettings
  ): void {
    applyMistVelocityForcesForTest(entry.density, entry.velocity, entry.resolution, buoyancy, velocityDrag, stepDt, boundaries);
  }

  private uploadDensity(entry: MistVolumeEntry): [number, number] {
    const byteRange = uploadMistDensityBytes(entry.density, entry.uploadBytes);
    entry.cpuTexture.needsUpdate = true;
    return byteRange;
  }

  private computeDensityRange(density: Float32Array): [number, number] {
    return computeMistDensityRange(density);
  }

  private disposeEntry(actorId: string): void {
    const entry = this.entriesByActorId.get(actorId);
    if (!entry) {
      return;
    }
    entry.previewGroup.parent?.remove(entry.previewGroup);
    entry.volumeMesh.geometry.dispose();
    entry.boundsMesh.geometry.dispose();
    entry.sliceMesh.geometry.dispose();
    entry.debugDensityPoints.geometry.dispose();
    (entry.debugDensityPoints.material as THREE.PointsMaterial).dispose();
    entry.debugVelocityLines.geometry.dispose();
    (entry.debugVelocityLines.material as THREE.LineBasicMaterial).dispose();
    entry.debugSourceLines.geometry.dispose();
    (entry.debugSourceLines.material as THREE.LineBasicMaterial).dispose();
    entry.debugLabelPlaneGeometry.dispose();
    for (const labelTexture of entry.debugLabelTextureCache.values()) {
      labelTexture.texture.dispose();
    }
    for (const child of [...entry.debugLabelGroup.children]) {
      if (child instanceof THREE.Mesh) {
        const material = child.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.dispose();
        }
      }
    }
    entry.volumeMaterial.dispose();
    entry.sliceMaterial.dispose();
    entry.boundsMaterial.dispose();
    entry.cpuTexture.dispose();
    this.entriesByActorId.delete(actorId);
  }
}

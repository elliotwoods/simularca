import * as THREE from "three";
import type {
  ActorNode,
  ActorRuntimeStatus,
  ActorStatusEntry,
  BeamArrayParams,
  BeamParams,
  PluginDefinition,
  PrimitiveDimensions,
  PrimitiveShape,
  ReloadableDescriptor,
  SceneHookContext
} from "./contracts";
import {
  buildBeamGeometryWorld,
  buildCombinedBeamGeometryWorld,
  computeSilhouetteWorld,
  sampleArcLengthCurveTs
} from "./math";

const SOLID_BEAM_TYPE = "solid";
const DEFAULT_RESOLUTION = 256;
const DEFAULT_BEAM_LENGTH = 100;
const DEFAULT_BEAM_COLOR = "#ffffff";
const DEFAULT_BEAM_ALPHA = 0.1;
const DEFAULT_ARRAY_COUNT = 32;
const LATE_RENDER_ORDER = 10_000;
const GHOST_BEAM_TYPE = "ghost";
const NORMALS_BEAM_TYPE = "normals";
const SCATTERING_SHELL_BEAM_TYPE = "scatteringShell";
const DEFAULT_HAZE_INTENSITY = 1.0;
const DEFAULT_SCATTERING_COEFFICIENT = 1.0;
const DEFAULT_EXTINCTION_COEFFICIENT = 0.05;
const DEFAULT_ANISOTROPY_G = 0.6;
const DEFAULT_BEAM_DIVERGENCE_RAD = 0.001;
const DEFAULT_BEAM_APERTURE_DIAMETER = 0.002;
const DEFAULT_DISTANCE_FALLOFF_EXPONENT = 1.5;
const DEFAULT_PATH_LENGTH_GAIN = 1.0;
const DEFAULT_PATH_LENGTH_EXPONENT = 2.0;
const DEFAULT_PHASE_GAIN = 1.0;
const DEFAULT_SCAN_DUTY = 1.0;
const DEFAULT_NEAR_FADE_START = 0.0;
const DEFAULT_NEAR_FADE_END = 0.0;
const DEFAULT_SOFT_CLAMP_KNEE = 0.25;
const EPSILON = 1e-4;

type BeamMaterial = THREE.MeshBasicMaterial | THREE.ShaderMaterial;

interface BeamObjectState {
  mesh: THREE.Mesh;
  material: BeamMaterial;
  geometry: THREE.BufferGeometry;
  lastGeometrySignature: string;
  lastMaterialSignature: string;
}

interface BeamRuntime {
  mode: "single" | "array";
}

function createBeamRoot(): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  const material = createSolidMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "beam-crossover-mesh";
  mesh.renderOrder = LATE_RENDER_ORDER;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "beam-crossover-root";
  group.add(mesh);
  (group.userData as { beamState?: BeamObjectState }).beamState = {
    mesh,
    material,
    geometry,
    lastGeometrySignature: "",
    lastMaterialSignature: ""
  };
  return group;
}

function getBeamState(object: unknown): BeamObjectState | null {
  if (!(object instanceof THREE.Group)) {
    return null;
  }
  const userData = object.userData as { beamState?: BeamObjectState };
  return userData.beamState ?? null;
}

function sanitizeColor(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_BEAM_COLOR;
  }
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed) ? trimmed : DEFAULT_BEAM_COLOR;
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
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

function softClamp(value: number, knee: number): number {
  if (knee <= 0) {
    return value;
  }
  return value / (1 + value * knee);
}

export interface ScatteringShellComputationInput {
  emitterPos: THREE.Vector3;
  worldPos: THREE.Vector3;
  worldNormal: THREE.Vector3;
  cameraPos: THREE.Vector3;
  beamAlpha: number;
  hazeIntensity: number;
  scatteringCoeff: number;
  extinctionCoeff: number;
  anisotropyG: number;
  beamDivergenceRad: number;
  beamApertureDiameter: number;
  distanceFalloffExponent: number;
  pathLengthGain: number;
  pathLengthExponent: number;
  phaseGain: number;
  scanDuty: number;
  nearFadeStart: number;
  nearFadeEnd: number;
  softClampKnee: number;
}

export interface ScatteringShellComputationResult {
  beamRadius: number;
  pathLengthTerm: number;
  normalViewTerm: number;
  phase: number;
  distanceTerm: number;
  extinctionTerm: number;
  nearFadeTerm: number;
  visibility: number;
  alpha: number;
}

export function computeScatteringShellVisibility(
  input: ScatteringShellComputationInput
): ScatteringShellComputationResult {
  const L = input.worldPos.clone().sub(input.emitterPos);
  const z = Math.max(L.length(), EPSILON);
  const beamDir = L.normalize();
  const V = input.cameraPos.clone().sub(input.worldPos);
  if (V.lengthSq() <= EPSILON * EPSILON) {
    return {
      beamRadius: 0.5 * input.beamApertureDiameter,
      pathLengthTerm: 1,
      normalViewTerm: 1,
      phase: 0,
      distanceTerm: 0,
      extinctionTerm: 0,
      nearFadeTerm: 1,
      visibility: 0,
      alpha: 0
    };
  }
  V.normalize();
  const normal = input.worldNormal.clone();
  if (normal.lengthSq() <= EPSILON * EPSILON) {
    return {
      beamRadius: 0.5 * input.beamApertureDiameter + z * input.beamDivergenceRad,
      pathLengthTerm: 1,
      normalViewTerm: 1,
      phase: 0,
      distanceTerm: 0,
      extinctionTerm: 0,
      nearFadeTerm: 1,
      visibility: 0,
      alpha: 0
    };
  }
  normal.normalize();

  const ndv = THREE.MathUtils.clamp(normal.dot(V), -1, 1);
  const grazing = Math.sqrt(Math.max(1 - ndv * ndv, 0));
  const rawPathLengthTerm = 1 + input.pathLengthGain * Math.pow(grazing, Math.max(input.pathLengthExponent, 0));
  const pathLengthTerm = softClamp(rawPathLengthTerm, Math.max(input.softClampKnee, 0));

  const normalViewTerm = 1 - 0.5 * Math.abs(ndv);

  const g = THREE.MathUtils.clamp(input.anisotropyG, -0.99, 0.99);
  const cosTheta = THREE.MathUtils.clamp(beamDir.dot(V), -1, 1);
  const phaseDenominator = Math.max(1 + g * g - 2 * g * cosTheta, EPSILON);
  const phase = ((1 - g * g) / Math.pow(phaseDenominator, 1.5)) * input.phaseGain;

  const beamRadius = 0.5 * Math.max(input.beamApertureDiameter, 0) + z * Math.max(input.beamDivergenceRad, 0);
  const distanceTerm = 1 / Math.pow(Math.max(z, EPSILON), Math.max(input.distanceFalloffExponent, 0));
  const extinctionTerm = Math.exp(-Math.max(input.extinctionCoeff, 0) * z);
  const nearFadeTerm =
    input.nearFadeEnd > input.nearFadeStart
      ? THREE.MathUtils.smoothstep(z, input.nearFadeStart, input.nearFadeEnd)
      : 1;

  const rawVisibility =
    Math.max(input.hazeIntensity, 0) *
    Math.max(input.scatteringCoeff, 0) *
    Math.max(input.scanDuty, 0) *
    distanceTerm *
    phase *
    pathLengthTerm *
    normalViewTerm *
    extinctionTerm *
    nearFadeTerm;
  const visibility = softClamp(Math.max(rawVisibility, 0), Math.max(input.softClampKnee, 0));
  return {
    beamRadius,
    pathLengthTerm,
    normalViewTerm,
    phase,
    distanceTerm,
    extinctionTerm,
    nearFadeTerm,
    visibility,
    alpha: THREE.MathUtils.clamp(input.beamAlpha, 0, 1) * visibility
  };
}

function parseBeamParams(actor: ActorNode): BeamParams {
  const beamType = actor.params.beamType;
  return {
    targetActorId: typeof actor.params.targetActorId === "string" ? actor.params.targetActorId : null,
    beamType:
      beamType === GHOST_BEAM_TYPE || beamType === NORMALS_BEAM_TYPE || beamType === SCATTERING_SHELL_BEAM_TYPE
        ? beamType
        : SOLID_BEAM_TYPE,
    resolution: Math.max(3, Math.min(1024, Math.floor(Number(actor.params.resolution ?? DEFAULT_RESOLUTION)) || DEFAULT_RESOLUTION)),
    beamLength: Math.max(0, Number(actor.params.beamLength ?? DEFAULT_BEAM_LENGTH) || DEFAULT_BEAM_LENGTH),
    beamColor: sanitizeColor(actor.params.beamColor),
    beamAlpha: Math.max(0, Math.min(1, Number(actor.params.beamAlpha ?? DEFAULT_BEAM_ALPHA) || DEFAULT_BEAM_ALPHA)),
    hazeIntensity: clampNumber(actor.params.hazeIntensity, DEFAULT_HAZE_INTENSITY, 0),
    scatteringCoeff: clampNumber(actor.params.scatteringCoeff, DEFAULT_SCATTERING_COEFFICIENT, 0),
    extinctionCoeff: clampNumber(actor.params.extinctionCoeff, DEFAULT_EXTINCTION_COEFFICIENT, 0),
    anisotropyG: clampNumber(actor.params.anisotropyG, DEFAULT_ANISOTROPY_G, -0.99, 0.99),
    beamDivergenceRad: clampNumber(actor.params.beamDivergenceRad, DEFAULT_BEAM_DIVERGENCE_RAD, 0),
    beamApertureDiameter: clampNumber(actor.params.beamApertureDiameter, DEFAULT_BEAM_APERTURE_DIAMETER, 0),
    distanceFalloffExponent: clampNumber(actor.params.distanceFalloffExponent, DEFAULT_DISTANCE_FALLOFF_EXPONENT, 0),
    pathLengthGain: clampNumber(actor.params.pathLengthGain, DEFAULT_PATH_LENGTH_GAIN, 0),
    pathLengthExponent: clampNumber(actor.params.pathLengthExponent, DEFAULT_PATH_LENGTH_EXPONENT, 0),
    phaseGain: clampNumber(actor.params.phaseGain, DEFAULT_PHASE_GAIN, 0),
    scanDuty: clampNumber(actor.params.scanDuty, DEFAULT_SCAN_DUTY, 0),
    nearFadeStart: clampNumber(actor.params.nearFadeStart, DEFAULT_NEAR_FADE_START, 0),
    nearFadeEnd: clampNumber(actor.params.nearFadeEnd, DEFAULT_NEAR_FADE_END, 0),
    softClampKnee: clampNumber(actor.params.softClampKnee, DEFAULT_SOFT_CLAMP_KNEE, 0)
  };
}

function parseBeamArrayParams(actor: ActorNode): BeamArrayParams {
  const base = parseBeamParams(actor);
  return {
    ...base,
    emitterCurveId: typeof actor.params.emitterCurveId === "string" ? actor.params.emitterCurveId : null,
    count: Math.max(1, Math.min(512, Math.floor(Number(actor.params.count ?? DEFAULT_ARRAY_COUNT)) || DEFAULT_ARRAY_COUNT))
  };
}

function formatVector(value: THREE.Vector3): [number, number, number] {
  return [value.x, value.y, value.z];
}

function readPrimitiveShape(actor: ActorNode): PrimitiveShape | null {
  const shape = actor.params.shape;
  return shape === "sphere" || shape === "cube" || shape === "cylinder" ? shape : null;
}

function readPrimitiveDimensions(actor: ActorNode): PrimitiveDimensions {
  return {
    cubeSize: Math.max(0, Number(actor.params.cubeSize ?? 1) || 1),
    sphereRadius: Math.max(0, Number(actor.params.sphereRadius ?? 0.5) || 0.5),
    cylinderRadius: Math.max(0, Number(actor.params.cylinderRadius ?? 0.5) || 0.5),
    cylinderHeight: Math.max(0, Number(actor.params.cylinderHeight ?? 1) || 1)
  };
}

function setStatus(context: SceneHookContext, values: Record<string, unknown>, error?: string): void {
  context.setActorStatus({
    values,
    error,
    updatedAtIso: new Date().toISOString()
  });
}

function buildSingleStatus(actor: ActorNode, runtimeStatus?: ActorRuntimeStatus): ActorStatusEntry[] {
  const params = parseBeamParams(actor);
  return [
    { label: "Type", value: "Beam Emitter" },
    { label: "Beam Type", value: params.beamType },
    { label: "Ghost Shading Active", value: params.beamType === GHOST_BEAM_TYPE },
    { label: "Normals Shading Active", value: params.beamType === NORMALS_BEAM_TYPE },
    { label: "Scattering Shell Active", value: params.beamType === SCATTERING_SHELL_BEAM_TYPE },
    { label: "WebGL-Only Mode", value: params.beamType === SCATTERING_SHELL_BEAM_TYPE },
    { label: "Target Actor", value: runtimeStatus?.values.targetActorName ?? "n/a" },
    { label: "Target Shape", value: runtimeStatus?.values.targetShape ?? "n/a" },
    { label: "Resolution", value: params.resolution },
    { label: "Beam Length (m)", value: params.beamLength },
    { label: "Beam Color", value: params.beamColor },
    { label: "Beam Alpha", value: params.beamAlpha },
    { label: "Anisotropy g", value: params.anisotropyG },
    { label: "Scan Duty", value: params.scanDuty },
    { label: "Divergence (rad)", value: params.beamDivergenceRad },
    { label: "Extinction", value: params.extinctionCoeff },
    { label: "Contour Points", value: runtimeStatus?.values.contourPointCount ?? 0 },
    { label: "Triangles", value: runtimeStatus?.values.triangleCount ?? 0 },
    { label: "Emitter Position (m)", value: runtimeStatus?.values.emitterPosition ?? "n/a" },
    { label: "Target Center (m)", value: runtimeStatus?.values.targetCenter ?? "n/a" },
    { label: "Render Order", value: runtimeStatus?.values.renderOrder ?? LATE_RENDER_ORDER },
    { label: "Updated", value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a" },
    { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
  ];
}

function buildArrayStatus(actor: ActorNode, runtimeStatus?: ActorRuntimeStatus): ActorStatusEntry[] {
  const params = parseBeamArrayParams(actor);
  return [
    { label: "Type", value: "Beam Emitter Array" },
    { label: "Beam Type", value: params.beamType },
    { label: "Ghost Shading Active", value: params.beamType === GHOST_BEAM_TYPE },
    { label: "Normals Shading Active", value: params.beamType === NORMALS_BEAM_TYPE },
    { label: "Scattering Shell Active", value: params.beamType === SCATTERING_SHELL_BEAM_TYPE },
    { label: "WebGL-Only Mode", value: params.beamType === SCATTERING_SHELL_BEAM_TYPE },
    { label: "Emitter Curve", value: runtimeStatus?.values.emitterCurveName ?? "n/a" },
    { label: "Target Actor", value: runtimeStatus?.values.targetActorName ?? "n/a" },
    { label: "Target Shape", value: runtimeStatus?.values.targetShape ?? "n/a" },
    { label: "Requested Count", value: params.count },
    { label: "Anisotropy g", value: params.anisotropyG },
    { label: "Scan Duty", value: params.scanDuty },
    { label: "Divergence (rad)", value: params.beamDivergenceRad },
    { label: "Extinction", value: params.extinctionCoeff },
    { label: "Active Beams", value: runtimeStatus?.values.activeBeamCount ?? 0 },
    { label: "Skipped Beams", value: runtimeStatus?.values.skippedBeamCount ?? 0 },
    { label: "Contour Points / Beam", value: runtimeStatus?.values.contourPointCount ?? 0 },
    { label: "Triangles", value: runtimeStatus?.values.triangleCount ?? 0 },
    { label: "Curve Closed", value: runtimeStatus?.values.curveClosed ?? "n/a" },
    { label: "Curve LUT Samples", value: runtimeStatus?.values.curveLutSamples ?? 0 },
    { label: "Ignores Actor Transform", value: true },
    { label: "Render Order", value: runtimeStatus?.values.renderOrder ?? LATE_RENDER_ORDER },
    { label: "Updated", value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a" },
    { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
  ];
}

export function computeGhostAlpha(viewVector: THREE.Vector3, normalVector: THREE.Vector3, alphaScale: number): number {
  const safeAlpha = Math.max(0, Math.min(1, alphaScale));
  const view = viewVector.clone();
  const normal = normalVector.clone();
  if (view.lengthSq() <= 1e-12 || normal.lengthSq() <= 1e-12) {
    return 0;
  }
  view.normalize();
  normal.normalize();
  return safeAlpha * Math.max(0, Math.min(1, view.cross(normal).length()));
}

function createSolidMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: DEFAULT_BEAM_ALPHA,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  material.userData.beamMaterialKind = SOLID_BEAM_TYPE;
  return material;
}

function createGhostMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      beamColor: { value: new THREE.Color(DEFAULT_BEAM_COLOR) },
      beamAlpha: { value: DEFAULT_BEAM_ALPHA }
    },
    vertexShader: `
      varying vec3 vViewPosition;
      varying vec3 vViewNormal;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = mvPosition.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 beamColor;
      uniform float beamAlpha;
      varying vec3 vViewPosition;
      varying vec3 vViewNormal;

      void main() {
        vec3 viewDir = normalize(vViewPosition);
        vec3 normalDir = normalize(vViewNormal);
        float ghost = clamp(length(cross(viewDir, normalDir)), 0.0, 1.0);
        gl_FragColor = vec4(beamColor, beamAlpha * ghost);
      }
    `
  });
  material.userData.beamMaterialKind = GHOST_BEAM_TYPE;
  return material;
}

function createNormalsMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    vertexShader: `
      varying vec3 vWorldNormal;

      void main() {
        vWorldNormal = normalize(mat3(transpose(inverse(modelMatrix))) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldNormal;

      void main() {
        vec3 encoded = normalize(vWorldNormal) * 0.5 + 0.5;
        gl_FragColor = vec4(encoded, 1.0);
      }
    `
  });
  material.userData.beamMaterialKind = NORMALS_BEAM_TYPE;
  return material;
}

type GhostMaterialUniforms = {
  beamColor: { value: THREE.Color };
  beamAlpha: { value: number };
};

type ScatteringShellUniforms = {
  uEmitterPos: { value: THREE.Vector3 };
  uBeamColor: { value: THREE.Color };
  uBaseAlpha: { value: number };
  uBeamDivergenceRad: { value: number };
  uBeamApertureDiameter: { value: number };
  uHazeIntensity: { value: number };
  uScatteringCoeff: { value: number };
  uExtinctionCoeff: { value: number };
  uAnisotropyG: { value: number };
  uDistanceFalloffExponent: { value: number };
  uPathLengthGain: { value: number };
  uPathLengthExponent: { value: number };
  uPhaseGain: { value: number };
  uScanDuty: { value: number };
  uNearFadeStart: { value: number };
  uNearFadeEnd: { value: number };
  uSoftClampKnee: { value: number };
  uCameraPos: { value: THREE.Vector3 };
};

function createScatteringShellMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uEmitterPos: { value: new THREE.Vector3() },
      uBeamColor: { value: new THREE.Color(DEFAULT_BEAM_COLOR) },
      uBaseAlpha: { value: DEFAULT_BEAM_ALPHA },
      uBeamDivergenceRad: { value: DEFAULT_BEAM_DIVERGENCE_RAD },
      uBeamApertureDiameter: { value: DEFAULT_BEAM_APERTURE_DIAMETER },
      uHazeIntensity: { value: DEFAULT_HAZE_INTENSITY },
      uScatteringCoeff: { value: DEFAULT_SCATTERING_COEFFICIENT },
      uExtinctionCoeff: { value: DEFAULT_EXTINCTION_COEFFICIENT },
      uAnisotropyG: { value: DEFAULT_ANISOTROPY_G },
      uDistanceFalloffExponent: { value: DEFAULT_DISTANCE_FALLOFF_EXPONENT },
      uPathLengthGain: { value: DEFAULT_PATH_LENGTH_GAIN },
      uPathLengthExponent: { value: DEFAULT_PATH_LENGTH_EXPONENT },
      uPhaseGain: { value: DEFAULT_PHASE_GAIN },
      uScanDuty: { value: DEFAULT_SCAN_DUTY },
      uNearFadeStart: { value: DEFAULT_NEAR_FADE_START },
      uNearFadeEnd: { value: DEFAULT_NEAR_FADE_END },
      uSoftClampKnee: { value: DEFAULT_SOFT_CLAMP_KNEE },
      uCameraPos: { value: new THREE.Vector3() }
    },
    vertexShader: `
      attribute vec3 beamEmitterPosition;

      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vEmitterPosition;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(transpose(inverse(modelMatrix))) * normal);
        vEmitterPosition = beamEmitterPosition;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uEmitterPos;
      uniform vec3 uBeamColor;
      uniform float uBaseAlpha;
      uniform float uBeamDivergenceRad;
      uniform float uBeamApertureDiameter;
      uniform float uHazeIntensity;
      uniform float uScatteringCoeff;
      uniform float uExtinctionCoeff;
      uniform float uAnisotropyG;
      uniform float uDistanceFalloffExponent;
      uniform float uPathLengthGain;
      uniform float uPathLengthExponent;
      uniform float uPhaseGain;
      uniform float uScanDuty;
      uniform float uNearFadeStart;
      uniform float uNearFadeEnd;
      uniform float uSoftClampKnee;
      uniform vec3 uCameraPos;

      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vEmitterPosition;

      float softClamp(float x, float knee) {
        if (knee <= 0.0) {
          return x;
        }
        return x / (1.0 + x * knee);
      }

      void main() {
        // This is a shell-based participating-medium approximation for scanned beam haze.
        // The mesh is only a proxy for visible in-scattered light, not a watertight volume.
        vec3 emitterPos = vEmitterPosition;
        vec3 L = vWorldPosition - emitterPos;
        float z = max(length(L), 1e-4);
        vec3 beamDir = normalize(L);
        vec3 V = normalize(uCameraPos - vWorldPosition);
        vec3 worldNormal = normalize(vWorldNormal);

        // Shell tangency is used as a path-length proxy: near-silhouette views read brighter.
        float NdV = clamp(dot(worldNormal, V), -1.0, 1.0);
        float grazing = sqrt(max(1.0 - NdV * NdV, 0.0));
        float pathLengthTerm = 1.0 + uPathLengthGain * pow(grazing, max(uPathLengthExponent, 0.0));
        pathLengthTerm = softClamp(pathLengthTerm, uSoftClampKnee);

        // This simple normal/view term keeps the shell brightest at silhouette and half as bright face-on.
        float normalViewTerm = 1.0 - 0.5 * abs(NdV);

        // Anisotropy g controls the HG-style phase behavior: positive is forward-scattering.
        float g = clamp(uAnisotropyG, -0.99, 0.99);
        float cosTheta = clamp(dot(beamDir, V), -1.0, 1.0);
        float phase = ((1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosTheta, 1e-4), 1.5)) * uPhaseGain;

        float beamRadius = 0.5 * max(uBeamApertureDiameter, 0.0) + z * max(uBeamDivergenceRad, 0.0);
        float distanceTerm = 1.0 / pow(max(z, 1e-4), max(uDistanceFalloffExponent, 0.0));

        // Extinction removes light along the path by absorption plus out-scattering.
        float extinctionTerm = exp(-max(uExtinctionCoeff, 0.0) * z);
        float nearFadeTerm = 1.0;
        if (uNearFadeEnd > uNearFadeStart) {
          nearFadeTerm = smoothstep(uNearFadeStart, uNearFadeEnd, z);
        }

        float visibility = max(uHazeIntensity, 0.0)
          * max(uScatteringCoeff, 0.0)
          * max(uScanDuty, 0.0)
          * distanceTerm
          * phase
          * pathLengthTerm
          * normalViewTerm
          * extinctionTerm
          * nearFadeTerm;

        visibility = softClamp(max(visibility, 0.0), uSoftClampKnee);
        float alpha = clamp(uBaseAlpha, 0.0, 1.0) * visibility;
        vec3 rgb = uBeamColor * visibility;

        // beamRadius is kept in the shader to document the shell's widening beam model.
        if (beamRadius < 0.0) {
          discard;
        }

        gl_FragColor = vec4(rgb, alpha);
      }
    `
  });
  material.userData.beamMaterialKind = SCATTERING_SHELL_BEAM_TYPE;
  return material;
}

function readCameraPosition(state: SceneHookContext["state"]): THREE.Vector3 {
  const position = state.camera?.position;
  if (Array.isArray(position) && position.length === 3) {
    return new THREE.Vector3(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
  }
  return new THREE.Vector3();
}

function updateMaterial(state: BeamObjectState, params: BeamParams, _cameraPosition: THREE.Vector3): void {
  const materialSignature = JSON.stringify({
    beamType: params.beamType,
    beamColor: params.beamColor,
    beamAlpha: params.beamAlpha,
    hazeIntensity: params.hazeIntensity,
    scatteringCoeff: params.scatteringCoeff,
    extinctionCoeff: params.extinctionCoeff,
    anisotropyG: params.anisotropyG,
    beamDivergenceRad: params.beamDivergenceRad,
    beamApertureDiameter: params.beamApertureDiameter,
    distanceFalloffExponent: params.distanceFalloffExponent,
    pathLengthGain: params.pathLengthGain,
    pathLengthExponent: params.pathLengthExponent,
    phaseGain: params.phaseGain,
    scanDuty: params.scanDuty,
    nearFadeStart: params.nearFadeStart,
    nearFadeEnd: params.nearFadeEnd,
    softClampKnee: params.softClampKnee
  });
  if (params.beamType === GHOST_BEAM_TYPE) {
    if (!(state.material instanceof THREE.ShaderMaterial) || state.material.userData.beamMaterialKind !== GHOST_BEAM_TYPE) {
      state.material.dispose();
      state.material = createGhostMaterial();
      state.mesh.material = state.material;
    }
    const material = state.material;
    const uniforms = material.uniforms as GhostMaterialUniforms;
    uniforms.beamColor.value.set(params.beamColor);
    uniforms.beamAlpha.value = params.beamAlpha;
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.needsUpdate = materialSignature !== state.lastMaterialSignature;
  } else if (params.beamType === NORMALS_BEAM_TYPE) {
    if (!(state.material instanceof THREE.ShaderMaterial) || state.material.userData.beamMaterialKind !== NORMALS_BEAM_TYPE) {
      state.material.dispose();
      state.material = createNormalsMaterial();
      state.mesh.material = state.material;
    }
    const material = state.material;
    material.transparent = false;
    material.opacity = 1;
    material.blending = THREE.NormalBlending;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.needsUpdate = materialSignature !== state.lastMaterialSignature;
  } else if (params.beamType === SCATTERING_SHELL_BEAM_TYPE) {
    if (!(state.material instanceof THREE.ShaderMaterial) || state.material.userData.beamMaterialKind !== SCATTERING_SHELL_BEAM_TYPE) {
      state.material.dispose();
      state.material = createScatteringShellMaterial();
      state.mesh.material = state.material;
    }
    const material = state.material;
    const uniforms = material.uniforms as ScatteringShellUniforms;
    uniforms.uBeamColor.value.set(params.beamColor);
    uniforms.uBaseAlpha.value = params.beamAlpha;
    uniforms.uBeamDivergenceRad.value = params.beamDivergenceRad;
    uniforms.uBeamApertureDiameter.value = params.beamApertureDiameter;
    uniforms.uHazeIntensity.value = params.hazeIntensity;
    uniforms.uScatteringCoeff.value = params.scatteringCoeff;
    uniforms.uExtinctionCoeff.value = params.extinctionCoeff;
    uniforms.uAnisotropyG.value = params.anisotropyG;
    uniforms.uDistanceFalloffExponent.value = params.distanceFalloffExponent;
    uniforms.uPathLengthGain.value = params.pathLengthGain;
    uniforms.uPathLengthExponent.value = params.pathLengthExponent;
    uniforms.uPhaseGain.value = params.phaseGain;
    uniforms.uScanDuty.value = params.scanDuty;
    uniforms.uNearFadeStart.value = params.nearFadeStart;
    uniforms.uNearFadeEnd.value = params.nearFadeEnd;
    uniforms.uSoftClampKnee.value = params.softClampKnee;
    uniforms.uCameraPos.value.copy(_cameraPosition);
    uniforms.uEmitterPos.value.set(0, 0, 0);
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.needsUpdate = materialSignature !== state.lastMaterialSignature;
  } else {
    if (!(state.material instanceof THREE.MeshBasicMaterial) || state.material.userData.beamMaterialKind !== SOLID_BEAM_TYPE) {
      state.material.dispose();
      state.material = createSolidMaterial();
      state.mesh.material = state.material;
    }
    const material = state.material;
    material.color.set(params.beamColor);
    material.transparent = true;
    material.opacity = params.beamAlpha;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.needsUpdate = materialSignature !== state.lastMaterialSignature;
  }
  state.lastMaterialSignature = materialSignature;
  state.mesh.renderOrder = params.beamType === NORMALS_BEAM_TYPE ? 0 : LATE_RENDER_ORDER;
}

function getWorldInverse(object: THREE.Object3D): THREE.Matrix4 {
  object.updateWorldMatrix(true, false);
  return object.matrixWorld.clone().invert();
}

function getWorldPosition(object: THREE.Object3D): THREE.Vector3 {
  object.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
}

function buildSingleGeometrySignature(params: BeamParams, emitterObject: THREE.Object3D, targetObject: THREE.Object3D, targetActor: ActorNode): string {
  emitterObject.updateWorldMatrix(true, false);
  targetObject.updateWorldMatrix(true, false);
  return JSON.stringify({
    beamLength: params.beamLength,
    resolution: params.resolution,
    emitterMatrix: emitterObject.matrixWorld.elements.map((value) => Number(value.toFixed(6))),
    targetMatrix: targetObject.matrixWorld.elements.map((value) => Number(value.toFixed(6))),
    shape: targetActor.params.shape,
    cubeSize: targetActor.params.cubeSize,
    sphereRadius: targetActor.params.sphereRadius,
    cylinderRadius: targetActor.params.cylinderRadius,
    cylinderHeight: targetActor.params.cylinderHeight
  });
}

function buildArrayGeometrySignature(params: BeamArrayParams, targetObject: THREE.Object3D, targetActor: ActorNode, curveActor: ActorNode): string {
  targetObject.updateWorldMatrix(true, false);
  return JSON.stringify({
    beamLength: params.beamLength,
    resolution: params.resolution,
    count: params.count,
    targetMatrix: targetObject.matrixWorld.elements.map((value) => Number(value.toFixed(6))),
    shape: targetActor.params.shape,
    cubeSize: targetActor.params.cubeSize,
    sphereRadius: targetActor.params.sphereRadius,
    cylinderRadius: targetActor.params.cylinderRadius,
    cylinderHeight: targetActor.params.cylinderHeight,
    curveTransform: curveActor.transform,
    curveData: curveActor.params.curveData,
    curveClosed: curveActor.params.closed,
    curveSamplesPerSegment: curveActor.params.samplesPerSegment
  });
}

function getCurveMetadata(actor: ActorNode): { closed: boolean; segmentCount: number } {
  const points = Array.isArray((actor.params.curveData as { points?: unknown[] } | undefined)?.points)
    ? ((actor.params.curveData as { points?: unknown[] }).points ?? [])
    : [];
  const closed = Boolean(actor.params.closed);
  const pointCount = points.length;
  return {
    closed,
    segmentCount: pointCount < 2 ? 0 : closed ? pointCount : pointCount - 1
  };
}

function syncSingleEmitter(context: SceneHookContext, root: THREE.Group, state: BeamObjectState): void {
  const params = parseBeamParams(context.actor);
  const targetActor = params.targetActorId ? context.getActorById(params.targetActorId) : null;
  const targetObject = params.targetActorId ? context.getActorObject(params.targetActorId) : null;
  if (!targetActor || targetActor.actorType !== "primitive" || !(targetObject instanceof THREE.Object3D)) {
    state.mesh.visible = false;
    setStatus(context, {
      targetActorName: targetActor?.name ?? "n/a",
      targetShape: "n/a",
      contourPointCount: 0,
      triangleCount: 0,
      renderOrder: state.mesh.renderOrder
    }, "Target actor must be a primitive with a scene object.");
    return;
  }

  const shape = readPrimitiveShape(targetActor);
  if (!shape) {
    state.mesh.visible = false;
    setStatus(context, {
      targetActorName: targetActor.name,
      targetShape: "unsupported",
      contourPointCount: 0,
      triangleCount: 0,
      renderOrder: state.mesh.renderOrder
    }, "Unsupported primitive shape.");
    return;
  }

  updateMaterial(state, params, readCameraPosition(context.state));

  const signature = buildSingleGeometrySignature(params, root, targetObject, targetActor);
  if (signature === state.lastGeometrySignature) {
    return;
  }

  const emitterWorld = getWorldPosition(root);
  if (params.beamType === SCATTERING_SHELL_BEAM_TYPE && state.material instanceof THREE.ShaderMaterial) {
    const uniforms = state.material.uniforms as Partial<ScatteringShellUniforms>;
    uniforms.uEmitterPos?.value.copy(emitterWorld);
  }
  targetObject.updateWorldMatrix(true, false);
  const silhouette = computeSilhouetteWorld({
    shape,
    dimensions: readPrimitiveDimensions(targetActor),
    targetWorldMatrix: targetObject.matrixWorld.clone(),
    emitterWorld,
    resolution: params.resolution
  });

  if (!silhouette.ok) {
    state.mesh.visible = false;
    setStatus(context, {
      targetActorName: targetActor.name,
      targetShape: shape,
      contourPointCount: 0,
      triangleCount: 0,
      emitterPosition: formatVector(emitterWorld),
      targetCenter: formatVector(silhouette.targetCenterWorld),
      renderOrder: state.mesh.renderOrder
    }, silhouette.reason);
    return;
  }

  const geometry = buildBeamGeometryWorld(emitterWorld, silhouette.contourWorld, params.beamLength, getWorldInverse(root));
  state.geometry.dispose();
  state.geometry = geometry;
  state.mesh.geometry = geometry;
  state.mesh.visible = true;
  state.lastGeometrySignature = signature;
  setStatus(context, {
    targetActorName: targetActor.name,
    targetShape: shape,
    contourPointCount: silhouette.contourWorld.length,
    triangleCount: silhouette.contourWorld.length,
    emitterPosition: formatVector(emitterWorld),
    targetCenter: formatVector(silhouette.targetCenterWorld),
    shadingMode: params.beamType,
    renderOrder: state.mesh.renderOrder
  });
}

function syncEmitterArray(context: SceneHookContext, root: THREE.Group, state: BeamObjectState): void {
  const params = parseBeamArrayParams(context.actor);
  const targetActor = params.targetActorId ? context.getActorById(params.targetActorId) : null;
  const curveActor = params.emitterCurveId ? context.getActorById(params.emitterCurveId) : null;
  const targetObject = params.targetActorId ? context.getActorObject(params.targetActorId) : null;
  if (!targetActor || targetActor.actorType !== "primitive" || !curveActor || curveActor.actorType !== "curve" || !(targetObject instanceof THREE.Object3D)) {
    state.mesh.visible = false;
    setStatus(context, {
      emitterCurveName: curveActor?.name ?? "n/a",
      targetActorName: targetActor?.name ?? "n/a",
      targetShape: "n/a",
      activeBeamCount: 0,
      skippedBeamCount: params.count,
      contourPointCount: 0,
      triangleCount: 0,
      renderOrder: state.mesh.renderOrder
    }, "Emitter Curve and Target Actor must reference valid curve/primitive actors.");
    return;
  }

  const shape = readPrimitiveShape(targetActor);
  if (!shape) {
    state.mesh.visible = false;
    setStatus(context, {
      emitterCurveName: curveActor.name,
      targetActorName: targetActor.name,
      targetShape: "unsupported",
      activeBeamCount: 0,
      skippedBeamCount: params.count,
      contourPointCount: 0,
      triangleCount: 0,
      renderOrder: state.mesh.renderOrder
    }, "Unsupported primitive shape.");
    return;
  }

  updateMaterial(state, params, readCameraPosition(context.state));

  const signature = buildArrayGeometrySignature(params, targetObject, targetActor, curveActor);
  if (signature === state.lastGeometrySignature) {
    return;
  }

  targetObject.updateWorldMatrix(true, false);
  const targetWorldMatrix = targetObject.matrixWorld.clone();
  const curveMetadata = getCurveMetadata(curveActor);
  const curveLutSamples = Math.max(128, curveMetadata.segmentCount * 64, params.count * 16);
  const ts = sampleArcLengthCurveTs(
    params.count,
    curveMetadata.closed,
    (t) => {
      const sampled = params.emitterCurveId ? context.sampleCurveWorldPoint(params.emitterCurveId, t) : null;
      return sampled ? new THREE.Vector3(...sampled.position) : null;
    },
    curveLutSamples
  );

  const placements: Array<{ emitterWorld: THREE.Vector3; contourWorld: THREE.Vector3[] }> = [];
  let skippedBeamCount = 0;
  let targetCenter = new THREE.Vector3();
  let lastError: string | undefined;
  for (const t of ts) {
    const sampled = params.emitterCurveId ? context.sampleCurveWorldPoint(params.emitterCurveId, t) : null;
    if (!sampled) {
      skippedBeamCount += 1;
      lastError = "Curve sampling returned no world point.";
      continue;
    }
    const emitterWorld = new THREE.Vector3(...sampled.position);
    const silhouette = computeSilhouetteWorld({
      shape,
      dimensions: readPrimitiveDimensions(targetActor),
      targetWorldMatrix,
      emitterWorld,
      resolution: params.resolution
    });
    targetCenter = silhouette.targetCenterWorld.clone();
    if (!silhouette.ok) {
      skippedBeamCount += 1;
      lastError = silhouette.reason;
      continue;
    }
    placements.push({
      emitterWorld,
      contourWorld: silhouette.contourWorld
    });
  }

  if (placements.length === 0) {
    state.mesh.visible = false;
    setStatus(context, {
      emitterCurveName: curveActor.name,
      targetActorName: targetActor.name,
      targetShape: shape,
      activeBeamCount: 0,
      skippedBeamCount,
      contourPointCount: params.resolution,
      triangleCount: 0,
      curveClosed: curveMetadata.closed,
      curveLutSamples,
      targetCenter: formatVector(targetCenter),
      renderOrder: state.mesh.renderOrder
    }, lastError ?? "No valid beam placements were produced.");
    return;
  }

  const geometry = buildCombinedBeamGeometryWorld(placements, params.beamLength, getWorldInverse(root));
  if (params.beamType === SCATTERING_SHELL_BEAM_TYPE && state.material instanceof THREE.ShaderMaterial) {
    const uniforms = state.material.uniforms as Partial<ScatteringShellUniforms>;
    uniforms.uEmitterPos?.value.copy(placements[0]?.emitterWorld ?? new THREE.Vector3());
  }
  state.geometry.dispose();
  state.geometry = geometry;
  state.mesh.geometry = geometry;
  state.mesh.visible = true;
  state.lastGeometrySignature = signature;
  setStatus(context, {
    emitterCurveName: curveActor.name,
    targetActorName: targetActor.name,
    targetShape: shape,
    activeBeamCount: placements.length,
    skippedBeamCount,
    contourPointCount: params.resolution,
    triangleCount: placements.length * params.resolution,
    curveClosed: curveMetadata.closed,
    curveLutSamples,
    targetCenter: formatVector(targetCenter),
    shadingMode: params.beamType,
    renderOrder: state.mesh.renderOrder
  });
}

function disposeBeamObject(object: unknown): void {
  const state = getBeamState(object);
  if (!state) {
    return;
  }
  state.geometry.dispose();
  state.material.dispose();
}

const sharedBeamParams = [
  {
    key: "beamType",
    label: "Beam Type",
    type: "select",
    options: [SOLID_BEAM_TYPE, GHOST_BEAM_TYPE, NORMALS_BEAM_TYPE, SCATTERING_SHELL_BEAM_TYPE],
    defaultValue: SOLID_BEAM_TYPE
  },
  {
    key: "resolution",
    label: "Resolution",
    type: "number",
    min: 3,
    max: 1024,
    step: 1,
    defaultValue: DEFAULT_RESOLUTION
  },
  {
    key: "beamLength",
    label: "Beam Length",
    type: "number",
    unit: "m",
    min: 0,
    step: 0.05,
    defaultValue: DEFAULT_BEAM_LENGTH
  },
  {
    key: "beamColor",
    label: "Beam Color",
    type: "color",
    defaultValue: DEFAULT_BEAM_COLOR
  },
  {
    key: "beamAlpha",
    label: "Beam Alpha",
    type: "number",
    min: 0,
    max: 1,
    step: 0.01,
    description:
      "Base transparency multiplier for the final shell intensity. In Scattering Shell mode this maps directly to the shader's base alpha after the scattering terms are evaluated.",
    defaultValue: DEFAULT_BEAM_ALPHA
  },
  {
    key: "hazeIntensity",
    label: "Haze Intensity",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_HAZE_INTENSITY,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Overall amount of visible atmospheric haze contributing to the beam. Increase this to make the shell read more strongly as light scattering through air, without changing the beam's directional behavior."
  },
  {
    key: "scatteringCoeff",
    label: "Scattering Coefficient",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_SCATTERING_COEFFICIENT,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Strength of scattering per unit distance in the participating medium approximation. Higher values make the beam contribute more visible in-scattered light before extinction and other directional terms are applied."
  },
  {
    key: "extinctionCoeff",
    label: "Extinction Coefficient",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_EXTINCTION_COEFFICIENT,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Rate at which light is removed along the beam by absorption plus out-scattering. Higher values cause the beam to fade more aggressively with distance from the emitter."
  },
  {
    key: "anisotropyG",
    label: "Anisotropy g",
    type: "number",
    min: -0.99,
    max: 0.99,
    step: 0.01,
    defaultValue: DEFAULT_ANISOTROPY_G,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Directional bias of the scattering phase function. 0 is isotropic, positive values favor forward scattering, and negative values favor backward scattering."
  },
  {
    key: "beamDivergenceRad",
    label: "Beam Divergence (rad)",
    type: "number",
    min: 0,
    step: 0.0001,
    defaultValue: DEFAULT_BEAM_DIVERGENCE_RAD,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Angular beam spread in radians as the beam travels away from the emitter. This is used to estimate beam widening over distance and supports the shell-based beam visibility model."
  },
  {
    key: "beamApertureDiameter",
    label: "Beam Aperture Diameter (m)",
    type: "number",
    min: 0,
    step: 0.0001,
    defaultValue: DEFAULT_BEAM_APERTURE_DIAMETER,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Approximate starting beam diameter at the emitter in meters. This gives the scattering model a practical initial beam size before divergence expands it downstream."
  },
  {
    key: "distanceFalloffExponent",
    label: "Distance Falloff Exponent",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_DISTANCE_FALLOFF_EXPONENT,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Controls how quickly beam visibility drops with distance from the emitter due to geometric spreading. Larger values darken distant parts of the shell more strongly."
  },
  {
    key: "pathLengthGain",
    label: "Path Length Gain",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_PATH_LENGTH_GAIN,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Extra brightness applied when the camera views the shell at a grazing angle. This acts as a shell tangency proxy for increased apparent path length through haze."
  },
  {
    key: "pathLengthExponent",
    label: "Path Length Exponent",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_PATH_LENGTH_EXPONENT,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Shapes how sharply the grazing-angle path-length effect ramps in. Higher values keep the effect subtle until the view becomes more tangent to the shell."
  },
  {
    key: "phaseGain",
    label: "Phase Gain",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_PHASE_GAIN,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Multiplier on the anisotropic phase-function term. Use this to rebalance the strength of angular scattering without retuning the rest of the haze model."
  },
  {
    key: "scanDuty",
    label: "Scan Duty",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_SCAN_DUTY,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Fractional occupancy of the scanned beam shell over time. Lower values reduce overall visibility to reflect that the shell represents a swept beam rather than a continuously filled volume."
  },
  {
    key: "nearFadeStart",
    label: "Near Fade Start",
    type: "number",
    min: 0,
    unit: "m",
    step: 0.01,
    defaultValue: DEFAULT_NEAR_FADE_START,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Distance from the emitter where the optional near fade begins. Use this to suppress excessive brightness very close to the source when needed."
  },
  {
    key: "nearFadeEnd",
    label: "Near Fade End",
    type: "number",
    min: 0,
    unit: "m",
    step: 0.01,
    defaultValue: DEFAULT_NEAR_FADE_END,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Distance from the emitter where the optional near fade reaches full strength. If this is not greater than Near Fade Start, the near-fade control is treated as disabled."
  },
  {
    key: "softClampKnee",
    label: "Soft Clamp Knee",
    type: "number",
    min: 0,
    step: 0.01,
    defaultValue: DEFAULT_SOFT_CLAMP_KNEE,
    visibleWhen: [{ key: "beamType", equals: SCATTERING_SHELL_BEAM_TYPE }],
    description:
      "Soft saturation strength used to tame brightness spikes from stacked gain terms. Higher values compress very bright regions more strongly while preserving smoother midrange behavior."
  }
] satisfies Array<Record<string, unknown>>;

export const beamEmitterDescriptor: ReloadableDescriptor<BeamRuntime> = {
  id: "plugin.beamCrossover.emitter",
  kind: "actor",
  version: 1,
  schema: {
    id: "plugin.beamCrossover.emitter",
    title: "Beam Emitter",
    params: [
      {
        key: "targetActorId",
        label: "Target Actor",
        type: "actor-ref",
        allowedActorTypes: ["primitive"],
        allowSelf: false
      },
      ...sharedBeamParams
    ]
  },
  spawn: {
    actorType: "plugin",
    pluginType: "plugin.beamCrossover.emitter",
    label: "Beam Emitter",
    description: "Analytic volumetric beam emitter targeting a primitive silhouette.",
    iconGlyph: "BM"
  },
  createRuntime: () => ({ mode: "single" }),
  updateRuntime: () => {},
  sceneHooks: {
    createObject: () => createBeamRoot(),
    syncObject: (context) => {
      const root = context.object instanceof THREE.Group ? context.object : null;
      const state = root ? getBeamState(root) : null;
      if (!root || !state) {
        context.setActorStatus({
          values: {},
          error: "Beam root object is invalid.",
          updatedAtIso: new Date().toISOString()
        });
        return;
      }
      syncSingleEmitter(context, root, state);
    },
    disposeObject: ({ object }) => {
      disposeBeamObject(object);
    }
  },
  status: {
    build({ actor, runtimeStatus }) {
      return buildSingleStatus(actor, runtimeStatus);
    }
  }
};

export const beamEmitterArrayDescriptor: ReloadableDescriptor<BeamRuntime> = {
  id: "plugin.beamCrossover.emitterArray",
  kind: "actor",
  version: 1,
  schema: {
    id: "plugin.beamCrossover.emitterArray",
    title: "Beam Emitter Array",
    params: [
      {
        key: "emitterCurveId",
        label: "Emitter Curve",
        type: "actor-ref",
        allowedActorTypes: ["curve"],
        allowSelf: false
      },
      {
        key: "targetActorId",
        label: "Target Actor",
        type: "actor-ref",
        allowedActorTypes: ["primitive"],
        allowSelf: false
      },
      {
        key: "count",
        label: "Count",
        type: "number",
        min: 1,
        max: 512,
        step: 1,
        defaultValue: DEFAULT_ARRAY_COUNT
      },
      ...sharedBeamParams
    ]
  },
  spawn: {
    actorType: "plugin",
    pluginType: "plugin.beamCrossover.emitterArray",
    label: "Beam Emitter Array",
    description: "Arc-length-spaced beam emitters driven by a curve.",
    iconGlyph: "BA"
  },
  createRuntime: () => ({ mode: "array" }),
  updateRuntime: () => {},
  sceneHooks: {
    createObject: () => createBeamRoot(),
    syncObject: (context) => {
      const root = context.object instanceof THREE.Group ? context.object : null;
      const state = root ? getBeamState(root) : null;
      if (!root || !state) {
        context.setActorStatus({
          values: {},
          error: "Beam root object is invalid.",
          updatedAtIso: new Date().toISOString()
        });
        return;
      }
      syncEmitterArray(context, root, state);
    },
    disposeObject: ({ object }) => {
      disposeBeamObject(object);
    }
  },
  status: {
    build({ actor, runtimeStatus }) {
      return buildArrayStatus(actor, runtimeStatus);
    }
  }
};

export function createBeamCrossoverPlugin(): PluginDefinition {
  return {
    id: "beam.crossover",
    name: "Beam Crossover",
    actorDescriptors: [beamEmitterDescriptor, beamEmitterArrayDescriptor],
    componentDescriptors: []
  };
}

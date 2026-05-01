import * as THREE from "three";
import { PMREMGenerator as WebGpuPMREMGenerator, WebGPURenderer } from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { AppKernel } from "@/app/kernel";
import type {
  ActorNode,
  ActorRuntimeStatus,
  AppState,
  DxfDrawingPlane,
  DxfInputUnits,
  DxfLayerStateMap,
  DxfSourcePlane,
  SceneAxesSettings,
  SceneGridSettings
} from "@/core/types";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { getEffectiveCurveHandlesAt } from "@/features/curves/handles";
import { curveDataWithOverrides, getCurveSamplesPerSegmentFromActor } from "@/features/curves/model";
import { estimateCurveLength, sampleCurvePositionAndTangent } from "@/features/curves/sampler";
import { parseDxf } from "@/features/dxf/parseDxf";
import { buildDxfScene, createDxfObject, disposeDxfObject, syncDxfAppearance } from "@/features/dxf/dxfToScene";
import type { BuiltDxfScene, ParsedDxfDocument } from "@/features/dxf/dxfTypes";
import { PluginActorRuntimeController } from "@/features/plugins/pluginActorRuntimeController";
import { resolveActorPlugin } from "@/features/plugins/pluginViews";
import { isPluginEnabled } from "@/features/plugins/pluginEnabled";
import { tryParseSplatBinary } from "@/features/splats/splatBinaryFormat";
import { getGaussianFilterMode, getGaussianFilterRegionActorIds } from "@/render/gaussianFilter";
import {
  environmentProbeCaptureIncompatibilityReason,
  formatEnvironmentProbeSkippedWarning
} from "@/render/environmentProbeCompatibility";
import { MistVolumeController, type MistVolumeQualityMode } from "@/render/mistVolumeController";
import type { ActorProfileMeta } from "@/render/profiling";
import { collectActorRenderOrder } from "@/render/sceneRenderOrder";
import { pruneInvalidSceneGraph } from "@/render/sceneGraphUtils";

const GAUSSIAN_RENDER_ROOT_NAME = "gaussian-splat-render-root";
const GAUSSIAN_RENDER_MESH_NAME = "gaussian-splat-render";
const MESH_RENDER_ROOT_NAME = "mesh-render-root";
const DXF_RENDER_ROOT_NAME = "dxf-render-root";
const CURVE_RENDER_LINE_NAME = "curve-render-line";
const SPLAT_COORDINATE_CORRECTION_EULER = new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ");
const SPLAT_COORDINATE_CORRECTION_QUATERNION = new THREE.Quaternion().setFromEuler(SPLAT_COORDINATE_CORRECTION_EULER);
const MATRIX_IDENTITY = new THREE.Matrix4().identity();
const MAX_GAUSSIAN_BILLBOARD_INSTANCES = 1000000;
const MAX_CPU_SORTED_SPLATS = 220000;

interface GaussianFallbackFilterRegion {
  actorId: string;
  shape: "sphere" | "cube" | "cylinder";
  radius: number;
  height: number;
  worldMatrixElements: number[];
  gaussianLocalToPrimitive: any;
}

interface GaussianFallbackFilterSpec {
  mode: "inside" | "outside";
  regions: GaussianFallbackFilterRegion[];
}

interface GaussianSortableBatch {
  actorId: string;
  mesh: any;
  count: number;
  trianglesPerInstance: number;
  centersBase: Float32Array;
  scalesBase: Float32Array;
  rotationsBase: Float32Array;
  colorsBase: Float32Array;
  chunks: GaussianSortChunk[];
  candidateIndices: number[];
  indices: number[];
  depths: Float32Array;
}

interface GaussianSortChunk {
  indices: Uint32Array;
  center: [number, number, number];
  radius: number;
}

interface MeshAnimationState {
  rootObject: THREE.Object3D;
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer | null;
  action: THREE.AnimationAction | null;
  activeClipName: string | null;
  activeClipDurationSeconds: number;
  enabled: boolean;
  clipTimeSeconds: number;
  poseRevision: number;
  skinnedMeshCount: number;
  morphTargetMeshCount: number;
  lastStatusSignature: string;
}

type SupportedRenderer = THREE.WebGLRenderer | {
  coordinateSystem?: unknown;
  xr: { enabled: boolean };
  setRenderTarget(target: unknown, activeCubeFace?: number, activeMipmapLevel?: number): void;
  getRenderTarget(): unknown;
  getActiveCubeFace(): number;
  getActiveMipmapLevel(): number;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  readRenderTargetPixelsAsync(
    renderTarget: any,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
    faceIndex?: number
  ): Promise<ArrayBufferView>;
};

type EnvironmentProbePmremTarget = {
  isPMREMRenderTarget?: boolean;
  isRenderTarget?: boolean;
  texture: THREE.Texture;
  dispose(): void;
};

type SupportedPmremGenerator = {
  fromCubemap(cubemap: THREE.CubeTexture, renderTarget?: EnvironmentProbePmremTarget | null): EnvironmentProbePmremTarget;
  dispose(): void;
};

interface EnvironmentSourceResolution {
  actorId: string | null;
  actorType: "environment" | "environment-probe" | null;
  name: string;
  texture: THREE.Texture | null;
}

interface EnvironmentProbeState {
  cubeCamera: THREE.CubeCamera;
  cubeRenderTarget: THREE.WebGLCubeRenderTarget;
  pmremTarget: EnvironmentProbePmremTarget | null;
  previewFaceUrls: string[];
  lastCaptureSignature: string;
  lastManualToken: number;
}

type DeferredGpuDisposable = {
  dispose(): void;
};

const ENVIRONMENT_PROBE_FACE_KEYS = ["px", "nx", "py", "ny", "pz", "nz"] as const;

export function buildEnvironmentProbeSelectedActorSignature(
  actorId: string,
  state: AppState
): string {
  const target = state.actors[actorId];
  const runtimeStatus = state.actorStatusByActorId[actorId];
  if (!target) {
    return `${actorId}:missing`;
  }
  return JSON.stringify({
    id: target.id,
    enabled: target.enabled,
    parentActorId: target.parentActorId,
    transform: target.transform,
    params: target.params,
    loadState: runtimeStatus?.values.loadState ?? null
  });
}

function buildActorProfileMeta(actor: ActorNode): ActorProfileMeta {
  return {
    actorId: actor.id,
    actorName: actor.name,
    actorType: actor.actorType,
    pluginType: actor.pluginType
  };
}

export interface SceneControllerOptions {
  qualityMode?: MistVolumeQualityMode;
  showDebugHelpers?: boolean;
}

function isDebugOnlyActor(actor: Pick<ActorNode, "actorType">): boolean {
  return actor.actorType === "curve";
}

export function computeActorObjectVisibility(
  actor: Pick<ActorNode, "actorType" | "enabled" | "visibilityMode">,
  isSelected: boolean,
  debugHelpersVisible: boolean
): boolean {
  const visibilityMode = actor.visibilityMode ?? "visible";
  const visibleByMode = visibilityMode === "visible" || (visibilityMode === "selected" && isSelected);
  return actor.enabled && visibleByMode && (!isDebugOnlyActor(actor) || debugHelpersVisible);
}

function formatLoadError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const maybeTarget = (error as { target?: { status?: number; statusText?: string } }).target;
    if (maybeTarget?.status !== undefined) {
      return `HTTP ${String(maybeTarget.status)} ${maybeTarget.statusText ?? ""}`.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown loader error object";
    }
  }
  return String(error);
}

function getAttribute(geometry: any, names: string[]): any {
  const normalize = (value: string) => value.trim().toLowerCase();
  for (const name of names) {
    const attribute = geometry.getAttribute?.(name);
    if (attribute) {
      return attribute;
    }
  }
  const attributes = geometry?.attributes as Record<string, unknown> | undefined;
  if (!attributes) {
    return null;
  }
  const entries = Object.entries(attributes);
  for (const name of names) {
    const needle = normalize(name);
    for (const [key, attribute] of entries) {
      if (normalize(key) === needle) {
        return attribute;
      }
    }
  }
  for (const name of names) {
    const needle = normalize(name);
    for (const [key, attribute] of entries) {
      const normalizedKey = normalize(key);
      if (normalizedKey.startsWith(`${needle}_`) || normalizedKey.startsWith(`${needle}-`)) {
        return attribute;
      }
    }
  }
  return null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function sanitizeMeshAnimationSpeed(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

function sanitizeMeshAnimationStartOffset(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeAnimationClipTimeSeconds(
  simTimeSeconds: number,
  speed: number,
  startOffsetSeconds: number,
  durationSeconds: number,
  loop: boolean
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  const rawTime = simTimeSeconds * speed + startOffsetSeconds;
  if (loop) {
    return ((rawTime % durationSeconds) + durationSeconds) % durationSeconds;
  }
  return Math.max(0, Math.min(durationSeconds, rawTime));
}

function countAnimatedMeshFeatures(object: THREE.Object3D): {
  skinnedMeshCount: number;
  morphTargetMeshCount: number;
} {
  let skinnedMeshCount = 0;
  let morphTargetMeshCount = 0;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    if (node instanceof THREE.SkinnedMesh) {
      skinnedMeshCount += 1;
    }
    const morphPosition = node.geometry?.morphAttributes?.position;
    if (Array.isArray(morphPosition) && morphPosition.length > 0) {
      morphTargetMeshCount += 1;
    }
  });
  return { skinnedMeshCount, morphTargetMeshCount };
}

function detectColorDenominator(attribute: any): number {
  if (!attribute) {
    return 1;
  }
  const array = attribute.array;
  if (array instanceof Uint16Array) {
    return 65535;
  }
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) {
    return 255;
  }
  const sampleCount = Math.min(4096, Math.max(0, Number(attribute.count ?? 0)));
  let max = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    max = Math.max(max, attribute.getX(i), attribute.getY(i), attribute.getZ(i));
  }
  if (max > 255.5) {
    return 65535;
  }
  if (max > 1.001) {
    return 255;
  }
  return 1;
}

function estimateAttributeSpread(attribute: any): number {
  if (!attribute || typeof attribute.count !== "number" || attribute.count <= 0) {
    return 0;
  }
  const sampleCount = Math.min(4096, attribute.count);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < sampleCount; i += 1) {
    min = Math.min(min, attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    max = Math.max(max, attribute.getX(i), attribute.getY(i), attribute.getZ(i));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  return Math.max(0, max - min);
}

function estimateAttributeMean(attribute: any): number {
  if (!attribute || typeof attribute.count !== "number" || attribute.count <= 0) {
    return 0;
  }
  const sampleCount = Math.min(4096, attribute.count);
  let sum = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    sum += attribute.getX(i) + attribute.getY(i) + attribute.getZ(i);
  }
  return sum / (sampleCount * 3);
}

function normalizeBackgroundColor(value: unknown): string {
  if (typeof value !== "string") {
    return "#070b12";
  }
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return "#070b12";
}

function normalizeHelperOpacity(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function applyLineOpacity(target: { material?: THREE.Material | THREE.Material[] }, opacity: number): void {
  const materials = Array.isArray(target.material) ? target.material : target.material ? [target.material] : [];
  const nextOpacity = normalizeHelperOpacity(opacity);
  for (const material of materials) {
    const lineMaterial = material as THREE.LineBasicMaterial;
    lineMaterial.transparent = nextOpacity < 1;
    lineMaterial.opacity = nextOpacity;
    lineMaterial.needsUpdate = true;
  }
}

function applyAxesColors(axes: THREE.AxesHelper, settings: SceneAxesSettings): void {
  const colorAttribute = axes.geometry.getAttribute("color");
  if (!colorAttribute || typeof colorAttribute.setXYZ !== "function") {
    return;
  }
  const xColor = new THREE.Color(normalizeBackgroundColor(settings.xColor));
  const yColor = new THREE.Color(normalizeBackgroundColor(settings.yColor));
  const zColor = new THREE.Color(normalizeBackgroundColor(settings.zColor));
  colorAttribute.setXYZ(0, xColor.r, xColor.g, xColor.b);
  colorAttribute.setXYZ(1, xColor.r, xColor.g, xColor.b);
  colorAttribute.setXYZ(2, yColor.r, yColor.g, yColor.b);
  colorAttribute.setXYZ(3, yColor.r, yColor.g, yColor.b);
  colorAttribute.setXYZ(4, zColor.r, zColor.g, zColor.b);
  colorAttribute.setXYZ(5, zColor.r, zColor.g, zColor.b);
  colorAttribute.needsUpdate = true;
}

function disposeHelper(target: { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] } | null): void {
  if (!target) {
    return;
  }
  target.geometry?.dispose();
  const materials = Array.isArray(target.material) ? target.material : target.material ? [target.material] : [];
  for (const material of materials) {
    material.dispose();
  }
}

function getDxfInputUnits(actor: ActorNode): DxfInputUnits {
  switch (actor.params.inputUnits) {
    case "centimeters":
    case "meters":
    case "inches":
    case "feet":
      return actor.params.inputUnits;
    case "millimeters":
    default:
      return "millimeters";
  }
}

function getDxfDrawingPlane(actor: ActorNode): DxfDrawingPlane {
  switch (actor.params.drawingPlane) {
    case "front-xy":
    case "side-zy":
      return actor.params.drawingPlane;
    case "plan-xz":
    default:
      return "plan-xz";
  }
}

function getDxfSourcePlane(actor: ActorNode): DxfSourcePlane {
  switch (actor.params.sourcePlane) {
    case "xy":
    case "yz":
    case "xz":
      return actor.params.sourcePlane;
    case "auto":
    default:
      return "auto";
  }
}

function getDxfCurveResolution(actor: ActorNode): number {
  const value = Number(actor.params.curveResolution ?? 32);
  if (!Number.isFinite(value)) {
    return 32;
  }
  return Math.max(4, Math.min(256, Math.floor(value)));
}

function getDxfLayerStates(actor: ActorNode): DxfLayerStateMap {
  const value = actor.params.layerStates;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as DxfLayerStateMap;
}

function readAttributeRange(attribute: any): { min: number; max: number } {
  if (!attribute || typeof attribute.count !== "number" || attribute.count <= 0) {
    return { min: 0, max: 0 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < attribute.count; i += 1) {
    const value = attribute.getX(i);
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
}

function correctedBoundsForViewport(bounds: any): any {
  const corners = [
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  ];
  for (const corner of corners) {
    corner.applyQuaternion(SPLAT_COORDINATE_CORRECTION_QUATERNION);
  }
  return new THREE.Box3().setFromPoints(corners);
}

function extractPlyVertexPropertyNames(bytes: Uint8Array): Set<string> {
  const limit = Math.min(bytes.byteLength, 1024 * 1024);
  const headerText = new TextDecoder().decode(bytes.subarray(0, limit));
  const endHeaderIndex = headerText.indexOf("end_header");
  if (endHeaderIndex < 0) {
    return new Set<string>();
  }
  const header = headerText.slice(0, endHeaderIndex);
  const lines = header.split(/\r\n|\n|\r/);
  const names = new Set<string>();
  let inVertexElement = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("element ")) {
      const parts = line.split(/\s+/);
      const elementName = parts[1];
      inVertexElement = elementName === "vertex";
      continue;
    }
    if (!inVertexElement) {
      continue;
    }
    if (!line.startsWith("property ")) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[1] === "list") {
      const name = parts[4];
      if (typeof name === "string" && name.length > 0) {
        names.add(name);
      }
    } else {
      const name = parts[2];
      if (typeof name === "string" && name.length > 0) {
        names.add(name);
      }
    }
  }
  return names;
}

export class SceneController {
  public readonly scene = new THREE.Scene();
  private gridHelper: THREE.GridHelper | null = null;
  private axesHelper: THREE.AxesHelper | null = null;
  private gridHelperSignature = "";
  private axesHelperSignature = "";
  private readonly actorObjects = new Map<string, any>();
  private readonly pluginDescriptorByActorId = new Map<string, ReloadableDescriptor | null>();
  private readonly gaussianAssetByActorId = new Map<string, string>();
  private readonly gaussianReloadTokenByActorId = new Map<string, number>();
  private readonly meshAssetByActorId = new Map<string, string>();
  private readonly meshReloadTokenByActorId = new Map<string, number>();
  private readonly dxfAssetByActorId = new Map<string, string>();
  private readonly dxfReloadTokenByActorId = new Map<string, number>();
  private readonly dxfDocumentByActorId = new Map<string, ParsedDxfDocument>();
  private readonly dxfSceneByActorId = new Map<string, BuiltDxfScene>();
  private readonly dxfBuildSignatureByActorId = new Map<string, string>();
  private readonly dxfAppearanceSignatureByActorId = new Map<string, string>();
  private readonly dxfStatusSignatureByActorId = new Map<string, string>();
  private readonly gaussianBoundsHelpers = new Map<string, any>();
  private readonly meshLoadTokenByActorId = new Map<string, number>();
  private readonly meshAnimationStateByActorId = new Map<string, MeshAnimationState>();
  private readonly primitiveSignatureByActorId = new Map<string, string>();
  private readonly materialByMaterialId = new Map<string, THREE.MeshStandardMaterial>();
  private readonly gaussianGeometryByActorId = new Map<string, any>();
  private readonly gaussianVisualSignatureByActorId = new Map<string, string>();
  private readonly gaussianVisibleCountByActorId = new Map<string, number>();
  private readonly gaussianTriangleCountByActorId = new Map<string, number>();
  private readonly gaussianSortableBatchesByActorId = new Map<string, GaussianSortableBatch>();
  private readonly curveSignatureByActorId = new Map<string, string>();
  private readonly lastKnownActorById = new Map<string, ActorNode>();
  private readonly meshMaterialSigByActorId = new Map<string, string>();
  private readonly plyLoader = new PLYLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly fbxLoader = new FBXLoader();
  private readonly colladaLoader = new ColladaLoader();
  private readonly objLoader = new OBJLoader();
  private readonly rgbeLoader = new RGBELoader();
  private readonly ktx2Loader = new KTX2Loader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly textureByUrl = new Map<string, THREE.Texture>();
  private readonly environmentTextureByActorId = new Map<string, THREE.Texture>();
  private readonly environmentAssetByActorId = new Map<string, string>();
  private readonly environmentReloadTokenByActorId = new Map<string, number>();
  private readonly environmentProbeStateByActorId = new Map<string, EnvironmentProbeState>();
  private readonly deferredGpuDisposals: DeferredGpuDisposable[] = [];
  private gaussianSpriteTexture: any | null = null;
  private currentEnvironmentAssetId: string | null = null;
  private gaussianSortFrameCounter = 0;
  private hasGaussianCameraState = false;
  private readonly gaussianLastCameraPosition = new THREE.Vector3();
  private readonly gaussianLastCameraQuaternion = new THREE.Quaternion();
  private gaussianSortDirty = true;
  private previousSimTimeSeconds = 0;
  private readonly mistVolumeController: MistVolumeController;
  private readonly pluginActorRuntimeController: PluginActorRuntimeController;
  private readonly showDebugHelpers: boolean;
  private debugHelpersVisible: boolean;
  private renderer: SupportedRenderer | null = null;
  private pmremGenerator: SupportedPmremGenerator | null = null;

  public constructor(private readonly kernel: AppKernel, options: SceneControllerOptions = {}) {
    this.showDebugHelpers = options.showDebugHelpers ?? true;
    this.debugHelpersVisible = this.showDebugHelpers;
    const initialState = this.kernel.store.getState().state;
    const initialBackground = normalizeBackgroundColor(initialState.scene.backgroundColor);
    this.scene.background = new THREE.Color(initialBackground);
    this.syncSceneHelpers(initialState.scene.helpers);
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(8, 12, 6);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.ktx2Loader.setTranscoderPath("/basis/");
    this.mistVolumeController = new MistVolumeController(this.kernel, {
      getActorById: (actorId) => this.kernel.store.getState().state.actors[actorId] ?? null,
      getActorObject: (actorId) => this.actorObjects.get(actorId) ?? null,
      sampleCurveWorldPoint: (actorId, t) => this.sampleCurveWorldPoint(actorId, t),
      getVolumetricRayResource: (actorId) => this.pluginActorRuntimeController.getVolumetricResource(actorId)
    }, options.qualityMode ?? "interactive");
    this.pluginActorRuntimeController = new PluginActorRuntimeController({
      resolveDescriptor: (actor) => this.resolveActorDescriptor(actor),
      isActorPluginEnabled: (actor) => this.isActorPluginEnabled(actor),
      setActorStatus: (actorId, status) => {
        this.kernel.store.getState().actions.setActorStatus(actorId, status);
      },
      addLog: (entry) => {
        this.kernel.store.getState().actions.addLog(entry);
      },
      profiler: this.kernel.profiler
    });
  }

  public getDebugHelpersVisible(): boolean {
    return this.debugHelpersVisible;
  }

  public setDebugHelpersVisible(visible: boolean): void {
    this.debugHelpersVisible = visible;
    this.applySceneHelperVisibility();
    for (const helper of this.gaussianBoundsHelpers.values()) {
      helper.visible = visible;
    }
    for (const actor of Object.values(this.kernel.store.getState().state.actors)) {
      if (actor.actorType !== "curve") {
        continue;
      }
      this.applyActorTransform(actor);
    }
  }

  private applySceneHelperVisibility(): void {
    const helperSettings = this.kernel.store.getState().state.scene.helpers;
    if (this.gridHelper) {
      this.gridHelper.visible = this.debugHelpersVisible && helperSettings.grid.visible;
    }
    if (this.axesHelper) {
      this.axesHelper.visible = this.debugHelpersVisible && helperSettings.axes.visible;
    }
  }

  private buildGridHelper(settings: SceneGridSettings): THREE.GridHelper {
    const grid = new THREE.GridHelper(
      Math.max(0.001, settings.size),
      Math.max(1, Math.round(settings.divisions)),
      normalizeBackgroundColor(settings.majorColor),
      normalizeBackgroundColor(settings.minorColor)
    );
    applyLineOpacity(grid, settings.opacity);
    return grid;
  }

  private buildAxesHelper(settings: SceneAxesSettings): THREE.AxesHelper {
    const axes = new THREE.AxesHelper(Math.max(0.001, settings.size));
    applyAxesColors(axes, settings);
    applyLineOpacity(axes, settings.opacity);
    return axes;
  }

  private syncSceneHelpers(settings: AppState["scene"]["helpers"]): void {
    const gridSignature = JSON.stringify({
      size: Math.max(0.001, settings.grid.size),
      divisions: Math.max(1, Math.round(settings.grid.divisions)),
      majorColor: normalizeBackgroundColor(settings.grid.majorColor),
      minorColor: normalizeBackgroundColor(settings.grid.minorColor),
      opacity: normalizeHelperOpacity(settings.grid.opacity)
    });
    if (gridSignature !== this.gridHelperSignature || !this.gridHelper) {
      this.gridHelper?.removeFromParent();
      disposeHelper(this.gridHelper);
      this.gridHelper = this.buildGridHelper(settings.grid);
      this.scene.add(this.gridHelper);
      this.gridHelperSignature = gridSignature;
    } else {
      applyLineOpacity(this.gridHelper, settings.grid.opacity);
    }

    const axesSignature = JSON.stringify({
      size: Math.max(0.001, settings.axes.size),
      xColor: normalizeBackgroundColor(settings.axes.xColor),
      yColor: normalizeBackgroundColor(settings.axes.yColor),
      zColor: normalizeBackgroundColor(settings.axes.zColor),
      opacity: normalizeHelperOpacity(settings.axes.opacity)
    });
    if (axesSignature !== this.axesHelperSignature || !this.axesHelper) {
      this.axesHelper?.removeFromParent();
      disposeHelper(this.axesHelper);
      this.axesHelper = this.buildAxesHelper(settings.axes);
      this.scene.add(this.axesHelper);
      this.axesHelperSignature = axesSignature;
    } else {
      applyAxesColors(this.axesHelper, settings.axes);
      applyLineOpacity(this.axesHelper, settings.axes.opacity);
    }

    this.applySceneHelperVisibility();
  }

  public async syncFromState(): Promise<void> {
    const profileFrameChunk = async <T,>(label: string, run: () => T | Promise<T>): Promise<T> => {
      if (!this.kernel.profiler.isCaptureActive()) {
        return await run();
      }
      return await this.kernel.profiler.withFrameChunk(label, run);
    };
    const profileActorChunk = <T,>(label: string, run: () => T | Promise<T>): T | Promise<T> => {
      if (!this.kernel.profiler.shouldProfileUpdates() || this.kernel.profiler.getDetailPreset() !== "standard") {
        return run();
      }
      return this.kernel.profiler.withChunk(label, run);
    };

    const state = this.kernel.store.getState().state;
    await profileFrameChunk("Scene helpers", () => {
      this.syncSceneHelpers(state.scene.helpers);
    });
    const actorIds = new Set(Object.keys(state.actors));
    const orderedActorIds = collectActorRenderOrder(
      state.scene.actorIds,
      state.actors,
      (actorId) => this.getActorDependencyIds(actorId, state)
    );
    const orderedActors = orderedActorIds
      .map((actorId) => state.actors[actorId])
      .filter((actor): actor is ActorNode => Boolean(actor));
    const simTimeSeconds = Number.isFinite(state.time.elapsedSimSeconds) ? state.time.elapsedSimSeconds : 0;
    const dtSeconds = Math.max(0, simTimeSeconds - this.previousSimTimeSeconds);
    this.previousSimTimeSeconds = simTimeSeconds;

    await profileFrameChunk("Scene cleanup", () => {
      for (const existing of [...this.actorObjects.keys()]) {
        if (!actorIds.has(existing)) {
          const object = this.actorObjects.get(existing);
          const removedActor = this.lastKnownActorById.get(existing) ?? null;
          this.disposePluginSceneObject(removedActor, object, this.pluginDescriptorByActorId.get(existing) ?? undefined);
          if (object) {
            object.parent?.remove(object);
          }
          this.actorObjects.delete(existing);
          this.gaussianAssetByActorId.delete(existing);
          this.gaussianReloadTokenByActorId.delete(existing);
          this.meshAssetByActorId.delete(existing);
          this.meshReloadTokenByActorId.delete(existing);
          this.dxfAssetByActorId.delete(existing);
          this.dxfReloadTokenByActorId.delete(existing);
          this.dxfDocumentByActorId.delete(existing);
          this.dxfSceneByActorId.delete(existing);
          this.dxfBuildSignatureByActorId.delete(existing);
          this.dxfAppearanceSignatureByActorId.delete(existing);
          this.dxfStatusSignatureByActorId.delete(existing);
          this.meshLoadTokenByActorId.delete(existing);
          this.disposeMeshAnimationState(existing);
          const helper = this.gaussianBoundsHelpers.get(existing);
          if (helper) {
            helper.parent?.remove(helper);
            this.gaussianBoundsHelpers.delete(existing);
          }
          this.gaussianGeometryByActorId.delete(existing);
          this.gaussianVisualSignatureByActorId.delete(existing);
          this.gaussianVisibleCountByActorId.delete(existing);
          this.gaussianTriangleCountByActorId.delete(existing);
          this.gaussianSortableBatchesByActorId.delete(existing);
          this.curveSignatureByActorId.delete(existing);
          this.meshMaterialSigByActorId.delete(existing);
          this.pluginDescriptorByActorId.delete(existing);
          this.environmentTextureByActorId.get(existing)?.dispose?.();
          this.environmentTextureByActorId.delete(existing);
          this.environmentAssetByActorId.delete(existing);
          this.environmentReloadTokenByActorId.delete(existing);
          this.disposeEnvironmentProbe(existing);
          if (object instanceof THREE.Group) {
            const dxfRoot = object.getObjectByName(DXF_RENDER_ROOT_NAME);
            if (dxfRoot instanceof THREE.Group) {
              disposeDxfObject(dxfRoot);
            }
          }
          this.kernel.store.getState().actions.setActorStatus(existing, null);
          this.primitiveSignatureByActorId.delete(existing);
          this.lastKnownActorById.delete(existing);
        }
      }
    });

    await profileFrameChunk("Plugin runtime sync", () => {
      this.pluginActorRuntimeController.sync(state, dtSeconds);
    });

    await profileFrameChunk("Actor update loop", async () => {
      for (const actor of orderedActors) {
        const syncActorWork = async () => {
          profileActorChunk("Actor bookkeeping", () => {
            this.lastKnownActorById.set(actor.id, actor);
          });
          await profileActorChunk("Ensure object", () => this.ensureActorObject(actor));
          profileActorChunk("Refresh plugin object", () => {
            this.refreshPluginSceneObjectIfNeeded(actor);
          });
          profileActorChunk("Parent attachment", () => {
            this.syncActorParentAttachment(actor.id, actor.parentActorId);
          });
          if (actor.actorType === "mesh") {
            const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
            const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
            const needsReload =
              assetId !== (this.meshAssetByActorId.get(actor.id) ?? "") ||
              reloadToken !== (this.meshReloadTokenByActorId.get(actor.id) ?? 0);
            if (needsReload) {
              await profileActorChunk("Mesh asset", () => this.syncMeshAsset(actor));
            }
            profileActorChunk("Mesh materials", () => {
              this.syncMeshMaterials(actor, state);
            });
            profileActorChunk("Mesh animation", () => {
              this.syncMeshAnimation(actor, simTimeSeconds);
            });
          }
          if (actor.actorType === "dxf-reference") {
            const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
            const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
            const needsReload =
              assetId !== (this.dxfAssetByActorId.get(actor.id) ?? "") ||
              reloadToken !== (this.dxfReloadTokenByActorId.get(actor.id) ?? 0);
            const needsInitialLoad =
              assetId.length > 0 &&
              !this.dxfDocumentByActorId.has(actor.id) &&
              !this.dxfStatusSignatureByActorId.has(actor.id);
            if (needsReload || needsInitialLoad) {
              await profileActorChunk("DXF asset", () => this.syncDxfReferenceAsset(actor));
            }
            profileActorChunk("DXF visuals", () => {
              this.syncDxfReferenceVisual(actor);
            });
          }
          if (actor.actorType === "primitive") {
            profileActorChunk("Primitive visuals", () => {
              this.syncPrimitiveActor(actor);
            });
          }
          if (actor.actorType === "curve") {
            profileActorChunk("Curve visuals", () => {
              this.syncCurveActor(actor);
            });
          }
          if (actor.actorType === "gaussian-splat-spark") {
            await profileActorChunk("Gaussian asset", () => this.syncGaussianSplatAsset(actor));
          }
          profileActorChunk("Transform", () => {
            this.applyActorTransform(actor);
          });
        };
        if (this.kernel.profiler.shouldProfileUpdates()) {
          await this.kernel.profiler.withActorPhase(buildActorProfileMeta(actor), "update", syncActorWork);
        } else {
          await syncActorWork();
        }
      }
    });

    await profileFrameChunk("Parent attachment sync", () => {
      for (const actor of orderedActors) {
        this.syncActorParentAttachment(actor.id, actor.parentActorId);
      }
    });

    await profileFrameChunk("Sibling/order sync", () => {
      this.syncActorSiblingOrder(state);
      this.applyActorRenderOrder(state);
    });

    await profileFrameChunk("Mist volume sync", () => {
      this.mistVolumeController.syncFromState(state, simTimeSeconds, dtSeconds);
    });

    await profileFrameChunk("Plugin scene hooks", () => {
      for (const actor of orderedActors) {
        this.syncPluginSceneActor(actor, state, simTimeSeconds, dtSeconds);
      }
    });

    await profileFrameChunk("Environment textures", () => this.syncEnvironmentTextures(state, orderedActorIds));
    await profileFrameChunk("Scene background", () => {
      this.applySceneBackgroundColor();
    });
    await profileFrameChunk("Environment probes", () => this.syncEnvironmentProbes(state, orderedActors));
    await profileFrameChunk("Scene graph prune", () => {
      pruneInvalidSceneGraph(this.scene);
    });
  }

  public setRenderer(renderer: SupportedRenderer | null): void {
    this.renderer = renderer;
    this.pmremGenerator?.dispose();
    this.pmremGenerator = null;
  }

  public setWebGlRenderer(renderer: THREE.WebGLRenderer | null): void {
    this.setRenderer(renderer);
    this.mistVolumeController.setWebGlRenderer(renderer);
  }

  public getActorObject(actorId: string): any | null {
    return this.actorObjects.get(actorId) ?? null;
  }

  public listActorObjectsForProfiling(): Array<{ actorId: string; object: THREE.Object3D }> {
    const entries: Array<{ actorId: string; object: THREE.Object3D }> = [];
    for (const [actorId, object] of this.actorObjects.entries()) {
      if (object instanceof THREE.Object3D) {
        entries.push({ actorId, object });
      }
    }
    return entries;
  }

  public getMistVolumeResource(actorId: string) {
    return this.mistVolumeController.getResource(actorId);
  }

  public dispose(): void {
    for (const texture of this.environmentTextureByActorId.values()) {
      texture.dispose?.();
    }
    this.environmentTextureByActorId.clear();
    for (const actorId of [...this.environmentProbeStateByActorId.keys()]) {
      this.disposeEnvironmentProbe(actorId);
    }
    this.flushDeferredGpuDisposals();
    this.pmremGenerator?.dispose();
    this.pmremGenerator = null;
    this.renderer = null;
    this.pluginActorRuntimeController.dispose();
    this.mistVolumeController.dispose();
  }

  public flushDeferredGpuDisposals(): void {
    while (this.deferredGpuDisposals.length > 0) {
      const disposable = this.deferredGpuDisposals.shift();
      try {
        disposable?.dispose();
      } catch {
        // Best-effort cleanup for retired GPU resources.
      }
    }
  }

  public hasDeferredGpuDisposals(): boolean {
    return this.deferredGpuDisposals.length > 0;
  }

  public getGaussianRenderStats(): { drawCalls: number; triangles: number; visibleCount: number } {
    let drawCalls = 0;
    let triangles = 0;
    let visibleCount = 0;
    for (const [actorId, count] of this.gaussianVisibleCountByActorId.entries()) {
      const object = this.actorObjects.get(actorId);
      if (!object || object.visible === false) {
        continue;
      }
      if (count > 0) {
        drawCalls += 1;
      }
      visibleCount += Math.max(0, Math.floor(count));
    }
    for (const [actorId, tri] of this.gaussianTriangleCountByActorId.entries()) {
      const object = this.actorObjects.get(actorId);
      if (!object || object.visible === false) {
        continue;
      }
      triangles += Math.max(0, Math.floor(tri));
    }
    return { drawCalls, triangles, visibleCount };
  }

  public updateGaussianDepthSorting(camera: any): void {
    if (!camera || !camera.matrixWorldInverse) {
      return;
    }
    const cameraPosition = new THREE.Vector3();
    const cameraQuaternion = new THREE.Quaternion();
    camera.getWorldPosition(cameraPosition);
    camera.getWorldQuaternion(cameraQuaternion);
    const cameraMoved =
      !this.hasGaussianCameraState ||
      cameraPosition.distanceToSquared(this.gaussianLastCameraPosition) > 1e-6 ||
      1 - Math.abs(cameraQuaternion.dot(this.gaussianLastCameraQuaternion)) > 1e-6;
    if (cameraMoved) {
      this.gaussianLastCameraPosition.copy(cameraPosition);
      this.gaussianLastCameraQuaternion.copy(cameraQuaternion);
      this.hasGaussianCameraState = true;
      this.gaussianSortDirty = true;
    }
    this.gaussianSortFrameCounter += 1;
    const shouldUpdate = this.gaussianSortDirty && (cameraMoved ? this.gaussianSortFrameCounter % 2 === 0 : true);
    if (!shouldUpdate) {
      return;
    }
    const projectionView = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projectionView);
    const chunkSphere = new THREE.Sphere();
    const cameraView = camera.matrixWorldInverse as any;
    const cameraWorldQuaternion = cameraQuaternion;
    const inverseCameraWorldQuaternion = cameraWorldQuaternion.clone().invert();
    const parentWorldQuaternion = new THREE.Quaternion();
    const localBillboardQuaternion = new THREE.Quaternion();
    const inPlaneQuaternion = new THREE.Quaternion();
    const combinedQuaternion = new THREE.Quaternion();
    const splatQuaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4();
    const parentMatrixWorld = new THREE.Matrix4();
    const centerWorld = new THREE.Vector3();
    const centerView = new THREE.Vector3();
    const localCenter = new THREE.Vector3();
    const localScale = new THREE.Vector3();
    const splatAxisWorld = new THREE.Vector3(1, 0, 0);
    const splatAxisCamera = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const tempColor = new THREE.Color(0xffffff);
    const chunkCenterWorld = new THREE.Vector3();

    for (const batch of this.gaussianSortableBatchesByActorId.values()) {
      const mesh = batch.mesh;
      if (!mesh || mesh.visible === false || !mesh.parent) {
        continue;
      }
      parentMatrixWorld.copy(mesh.parent.matrixWorld);
      mesh.parent.getWorldQuaternion(parentWorldQuaternion);
      localBillboardQuaternion.copy(parentWorldQuaternion).invert().multiply(cameraWorldQuaternion);
      const parentScale = mesh.parent.getWorldScale(new THREE.Vector3());
      const chunkRadiusScaleFactor = Math.max(
        Math.abs(parentScale.x) || 1,
        Math.abs(parentScale.y) || 1,
        Math.abs(parentScale.z) || 1
      );
      const count = Math.max(0, Math.min(batch.count, Math.floor(batch.centersBase.length / 3)));
      if (count <= 0) {
        mesh.count = 0;
        this.gaussianVisibleCountByActorId.set(batch.actorId, 0);
        this.gaussianTriangleCountByActorId.set(batch.actorId, 0);
        continue;
      }

      const candidates = batch.candidateIndices;
      candidates.length = 0;
      if (batch.chunks.length <= 0) {
        for (let i = 0; i < count; i += 1) {
          candidates.push(i);
        }
      } else {
        for (const chunk of batch.chunks) {
          chunkCenterWorld.set(chunk.center[0], chunk.center[1], chunk.center[2]).applyMatrix4(parentMatrixWorld);
          chunkSphere.center.copy(chunkCenterWorld);
          chunkSphere.radius = Math.max(0.001, chunk.radius * chunkRadiusScaleFactor);
          if (!frustum.intersectsSphere(chunkSphere)) {
            continue;
          }
          for (let i = 0; i < chunk.indices.length; i += 1) {
            const source = chunk.indices[i] ?? 0;
            if (source >= 0 && source < count) {
              candidates.push(source);
            }
          }
        }
      }

      const candidateCount = candidates.length;
      if (candidateCount <= 0) {
        mesh.count = 0;
        this.gaussianVisibleCountByActorId.set(batch.actorId, 0);
        this.gaussianTriangleCountByActorId.set(batch.actorId, 0);
        continue;
      }

      let workingCount = candidateCount;
      if (workingCount > MAX_CPU_SORTED_SPLATS) {
        const stride = Math.max(2, Math.ceil(workingCount / MAX_CPU_SORTED_SPLATS));
        let write = 0;
        for (let read = 0; read < workingCount; read += stride) {
          batch.indices[write] = candidates[read] ?? 0;
          write += 1;
        }
        workingCount = write;
      } else {
        for (let i = 0; i < workingCount; i += 1) {
          batch.indices[i] = candidates[i] ?? 0;
        }
      }

      for (let i = 0; i < workingCount; i += 1) {
        const source = batch.indices[i] ?? 0;
        const i3 = source * 3;
        centerWorld.set(batch.centersBase[i3] ?? 0, batch.centersBase[i3 + 1] ?? 0, batch.centersBase[i3 + 2] ?? 0);
        centerWorld.applyMatrix4(parentMatrixWorld);
        centerView.copy(centerWorld).applyMatrix4(cameraView);
        batch.depths[source] = centerView.z;
      }

      batch.indices.length = workingCount;
      batch.indices.sort((a, b) => {
        const da = batch.depths[a] ?? 0;
        const db = batch.depths[b] ?? 0;
        return da - db;
      });

      for (let sorted = 0; sorted < workingCount; sorted += 1) {
        const source = batch.indices[sorted] ?? sorted;
        const src3 = source * 3;
        localCenter.set(batch.centersBase[src3] ?? 0, batch.centersBase[src3 + 1] ?? 0, batch.centersBase[src3 + 2] ?? 0);
        const src2 = source * 2;
        localScale.set(batch.scalesBase[src2] ?? 1, batch.scalesBase[src2 + 1] ?? 1, 1);
        const src4 = source * 4;
        splatQuaternion.set(
          batch.rotationsBase[src4] ?? 0,
          batch.rotationsBase[src4 + 1] ?? 0,
          batch.rotationsBase[src4 + 2] ?? 0,
          batch.rotationsBase[src4 + 3] ?? 1
        );
        if (splatQuaternion.lengthSq() < 1e-10) {
          splatQuaternion.set(0, 0, 0, 1);
        } else {
          splatQuaternion.normalize();
        }
        splatAxisWorld.set(1, 0, 0).applyQuaternion(splatQuaternion).applyQuaternion(parentWorldQuaternion);
        splatAxisCamera.copy(splatAxisWorld).applyQuaternion(inverseCameraWorldQuaternion);
        const angle = Math.atan2(splatAxisCamera.y, splatAxisCamera.x);
        inPlaneQuaternion.setFromAxisAngle(zAxis, angle);
        combinedQuaternion.copy(localBillboardQuaternion).multiply(inPlaneQuaternion);
        matrix.compose(localCenter, combinedQuaternion, localScale);
        mesh.setMatrixAt(sorted, matrix);
        tempColor.setRGB(
          batch.colorsBase[src3] ?? 1,
          batch.colorsBase[src3 + 1] ?? 1,
          batch.colorsBase[src3 + 2] ?? 1
        );
        mesh.setColorAt(sorted, tempColor);
      }

      mesh.count = workingCount;
      this.gaussianVisibleCountByActorId.set(batch.actorId, workingCount);
      this.gaussianTriangleCountByActorId.set(batch.actorId, workingCount * batch.trianglesPerInstance);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
    this.gaussianSortDirty = false;
  }

  private async ensureActorObject(actor: ActorNode): Promise<void> {
    if (!this.actorObjects.has(actor.id)) {
      const object = await this.createObjectForActor(actor);
      this.actorObjects.set(actor.id, object);
    }
  }

  private refreshPluginSceneObjectIfNeeded(actor: ActorNode): void {
    if (actor.actorType !== "plugin") {
      return;
    }
    const descriptor = this.resolveActorDescriptor(actor);
    const previousDescriptor = this.pluginDescriptorByActorId.get(actor.id);
    if (descriptor === previousDescriptor) {
      return;
    }
    const previousObject = this.actorObjects.get(actor.id);
    this.disposePluginSceneObject(actor, previousObject, previousDescriptor ?? undefined);
    if (previousObject) {
      previousObject.parent?.remove(previousObject);
    }
    const nextObject = this.createPluginSceneObject(actor);
    this.actorObjects.set(actor.id, nextObject);
    this.pluginDescriptorByActorId.set(actor.id, descriptor);
  }

  private syncActorParentAttachment(actorId: string, parentActorId: string | null): void {
    const object = this.actorObjects.get(actorId);
    if (!object) {
      return;
    }
    const parentObject = parentActorId ? this.actorObjects.get(parentActorId) : this.scene;
    const targetParent = parentObject ?? this.scene;
    if (object.parent === targetParent) {
      return;
    }
    object.parent?.remove(object);
    targetParent.add(object);
  }

  private syncActorSiblingOrder(state: AppState): void {
    this.syncOrderedChildren(this.scene, state.scene.actorIds.map((actorId) => this.actorObjects.get(actorId)).filter(Boolean));
    for (const actor of Object.values(state.actors)) {
      const parentObject = this.actorObjects.get(actor.id);
      if (!parentObject) {
        continue;
      }
      this.syncOrderedChildren(
        parentObject,
        actor.childActorIds.map((childId) => this.actorObjects.get(childId)).filter(Boolean)
      );
    }
  }

  private syncOrderedChildren(parentObject: any, desiredChildren: any[]): void {
    if (!parentObject || desiredChildren.length === 0) {
      return;
    }
    const desiredSet = new Set(desiredChildren);
    const currentActorChildren = (parentObject.children as any[]).filter((child) => desiredSet.has(child));
    const orderMatches =
      currentActorChildren.length === desiredChildren.length &&
      currentActorChildren.every((child, index) => child === desiredChildren[index]);
    if (orderMatches) {
      return;
    }
    for (const child of desiredChildren) {
      if (child.parent === parentObject) {
        parentObject.remove(child);
      }
    }
    for (const child of desiredChildren) {
      parentObject.add(child);
    }
  }

  private getActorDependencyIds(actorId: string, state: AppState): string[] {
    const actor = state.actors[actorId];
    if (!actor) {
      return [];
    }
    const dependencies = new Set<string>();
    const descriptor = this.resolveActorDescriptor(actor);
    for (const definition of descriptor?.schema.params ?? []) {
      const value = actor.params[definition.key];
      if (definition.type === "actor-ref" && typeof value === "string" && value.length > 0) {
        dependencies.add(value);
      }
      if (definition.type === "actor-ref-list" && Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string" && entry.length > 0) {
            dependencies.add(entry);
          }
        }
      }
    }
    return [...dependencies];
  }

  private applyActorRenderOrder(state: AppState): void {
    const orderedActorIds = collectActorRenderOrder(
      state.scene.actorIds,
      state.actors,
      (actorId) => this.getActorDependencyIds(actorId, state)
    );
    const stride = 10;
    orderedActorIds.forEach((actorId, index) => {
      const object = this.actorObjects.get(actorId);
      if (!object) {
        return;
      }
      const renderOrder = index * stride;
      object.traverse((node: any) => {
        node.renderOrder = renderOrder;
      });
    });
  }

  private async createObjectForActor(actor: ActorNode): Promise<any> {
    const pluginCreated = this.createPluginSceneObject(actor);
    if (actor.actorType === "plugin") {
      this.pluginDescriptorByActorId.set(actor.id, this.resolveActorDescriptor(actor));
    }
    if (pluginCreated) {
      return pluginCreated;
    }
    if (actor.actorType === "mesh") {
      const container = new THREE.Group();
      container.name = "mesh-container";
      const renderRoot = new THREE.Group();
      renderRoot.name = MESH_RENDER_ROOT_NAME;
      container.add(renderRoot);
      return container;
    }

    if (actor.actorType === "dxf-reference") {
      const container = new THREE.Group();
      container.name = "dxf-container";
      return container;
    }

    if (actor.actorType === "environment") {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.15),
        new THREE.MeshStandardMaterial({ color: 0x33ffaa, emissive: 0x112222 })
      );
      return marker;
    }

    if (actor.actorType === "environment-probe") {
      const group = new THREE.Group();
      group.name = "environment-probe";
      return group;
    }

    if (actor.actorType === "primitive") {
      return this.createPrimitiveMesh(actor);
    }

    if (actor.actorType === "curve") {
      const group = new THREE.Group();
      group.name = "curve-container";
      group.visible = this.debugHelpersVisible;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]),
        new THREE.LineBasicMaterial({
          color: 0x78ffcb,
          transparent: true,
          opacity: 0.95
        })
      );
      line.name = CURVE_RENDER_LINE_NAME;
      line.frustumCulled = false;
      group.add(line);
      return group;
    }

    if (actor.actorType === "plugin") {
      return new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.25, 0.25),
        new THREE.MeshStandardMaterial({ color: 0xfa9a00 })
      );
    }

    return new THREE.Group();
  }

  private getPrimitiveShape(actor: ActorNode): "cube" | "sphere" | "cylinder" {
    const shape = typeof actor.params.shape === "string" ? actor.params.shape : "cube";
    if (shape === "sphere" || shape === "cylinder" || shape === "cube") {
      return shape;
    }
    return "cube";
  }

  private getPrimitiveDimensions(actor: ActorNode): {
    shape: "cube" | "sphere" | "cylinder";
    cubeSize: number;
    sphereRadius: number;
    cylinderRadius: number;
    cylinderHeight: number;
    segments: number;
  } {
    const shape = this.getPrimitiveShape(actor);
    const cubeSizeRaw = Number(actor.params.cubeSize ?? 1);
    const sphereRadiusRaw = Number(actor.params.sphereRadius ?? 0.5);
    const cylinderRadiusRaw = Number(actor.params.cylinderRadius ?? 0.5);
    const cylinderHeightRaw = Number(actor.params.cylinderHeight ?? 1);
    const segmentsRaw = Number(actor.params.segments ?? 24);
    return {
      shape,
      cubeSize: Number.isFinite(cubeSizeRaw) ? Math.max(0, cubeSizeRaw) : 1,
      sphereRadius: Number.isFinite(sphereRadiusRaw) ? Math.max(0, sphereRadiusRaw) : 0.5,
      cylinderRadius: Number.isFinite(cylinderRadiusRaw) ? Math.max(0, cylinderRadiusRaw) : 0.5,
      cylinderHeight: Number.isFinite(cylinderHeightRaw) ? Math.max(0, cylinderHeightRaw) : 1,
      segments: Number.isFinite(segmentsRaw) ? Math.max(1, Math.floor(segmentsRaw)) : 24
    };
  }

  private createPrimitiveGeometry(
    shape: "cube" | "sphere" | "cylinder",
    cubeSize: number,
    sphereRadius: number,
    cylinderRadius: number,
    cylinderHeight: number,
    segments: number
  ): any {
    const safeSegments = Math.max(1, Math.floor(segments));
    const safeRoundSegments = Math.max(3, safeSegments);
    switch (shape) {
      case "sphere":
        return new THREE.SphereGeometry(Math.max(0, sphereRadius), safeRoundSegments, safeRoundSegments);
      case "cylinder":
        return new THREE.CylinderGeometry(
          Math.max(0, cylinderRadius),
          Math.max(0, cylinderRadius),
          Math.max(0, cylinderHeight),
          safeRoundSegments
        );
      case "cube":
      default:
        return new THREE.BoxGeometry(
          Math.max(0, cubeSize),
          Math.max(0, cubeSize),
          Math.max(0, cubeSize),
          safeSegments,
          safeSegments,
          safeSegments
        );
    }
  }

  private resolveEnvironment(actorId: string): EnvironmentSourceResolution {
    const state = this.kernel.store.getState().state;
    const actor = state.actors[actorId];
    if (!actor) {
      return { actorId: null, actorType: null, texture: null, name: "Default" };
    }

    const overrideActorId =
      typeof actor.params.environmentSourceId === "string" && actor.params.environmentSourceId.length > 0
        ? actor.params.environmentSourceId
        : null;
    if (overrideActorId) {
      return this.resolveEnvironmentSourceByActorId(overrideActorId);
    }

    const candidateActors = Object.values(state.actors).filter((entry) => {
      if (!entry.enabled) {
        return false;
      }
      if (entry.actorType === "environment") {
        return this.environmentTextureByActorId.has(entry.id);
      }
      if (entry.actorType === "environment-probe") {
        const probeState = this.environmentProbeStateByActorId.get(entry.id);
        return Boolean(probeState?.pmremTarget?.texture);
      }
      return false;
    });
    if (candidateActors.length === 0) {
      return { actorId: null, actorType: null, texture: null, name: "Default" };
    }

    const actorPos = new THREE.Vector3(...actor.transform.position);
    let closestEnv: ActorNode | null = null;
    let minDistanceSq = Number.POSITIVE_INFINITY;

    for (const env of candidateActors) {
      const envPos = new THREE.Vector3(...env.transform.position);
      const distSq = actorPos.distanceToSquared(envPos);
      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestEnv = env;
      }
    }

    return closestEnv ? this.resolveEnvironmentSourceByActorId(closestEnv.id) : { actorId: null, actorType: null, texture: null, name: "Default" };
  }

  private resolveEnvironmentSourceByActorId(actorId: string | null): EnvironmentSourceResolution {
    if (!actorId) {
      return { actorId: null, actorType: null, texture: null, name: "Default" };
    }
    const actor = this.kernel.store.getState().state.actors[actorId];
    if (!actor || !actor.enabled) {
      return { actorId: null, actorType: null, texture: null, name: "Default" };
    }
    if (actor.actorType === "environment") {
      return {
        actorId: actor.id,
        actorType: "environment",
        texture: this.environmentTextureByActorId.get(actor.id) ?? null,
        name: actor.name
      };
    }
    if (actor.actorType === "environment-probe") {
      return {
        actorId: actor.id,
        actorType: "environment-probe",
        texture: this.environmentProbeStateByActorId.get(actor.id)?.pmremTarget?.texture ?? null,
        name: actor.name
      };
    }
    return { actorId: null, actorType: null, texture: null, name: "Default" };
  }

  private async syncEnvironmentTextures(state: AppState, orderedActorIds: string[]): Promise<void> {
    const environmentActors = orderedActorIds
      .map((actorId) => state.actors[actorId])
      .filter((actor): actor is ActorNode => actor !== undefined && actor.actorType === "environment");
    const activeIds = new Set(environmentActors.map((actor) => actor.id));

    for (const existingId of [...this.environmentTextureByActorId.keys()]) {
      if (activeIds.has(existingId)) {
        continue;
      }
      this.environmentTextureByActorId.get(existingId)?.dispose?.();
      this.environmentTextureByActorId.delete(existingId);
      this.environmentAssetByActorId.delete(existingId);
      this.environmentReloadTokenByActorId.delete(existingId);
    }

    for (const actor of environmentActors) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
      if (!assetId) {
        this.environmentTextureByActorId.get(actor.id)?.dispose?.();
        this.environmentTextureByActorId.delete(actor.id);
        this.environmentAssetByActorId.delete(actor.id);
        this.environmentReloadTokenByActorId.delete(actor.id);
        this.kernel.store.getState().actions.setActorStatus(actor.id, {
          values: { loadState: "idle" },
          updatedAtIso: new Date().toISOString()
        });
        continue;
      }
      const unchanged =
        this.environmentAssetByActorId.get(actor.id) === assetId &&
        this.environmentReloadTokenByActorId.get(actor.id) === reloadToken &&
        this.environmentTextureByActorId.has(actor.id);
      if (unchanged) {
        continue;
      }
      this.environmentTextureByActorId.get(actor.id)?.dispose?.();
      const texture = await this.loadEnvironmentTexture(actor, state, assetId);
      if (!texture) {
        continue;
      }
      this.environmentTextureByActorId.set(actor.id, texture);
      this.environmentAssetByActorId.set(actor.id, assetId);
      this.environmentReloadTokenByActorId.set(actor.id, reloadToken);
    }

    const primary = environmentActors.find((entry) => this.environmentTextureByActorId.has(entry.id));
    if (primary) {
      this.currentEnvironmentAssetId = this.environmentAssetByActorId.get(primary.id) ?? null;
      const texture = this.environmentTextureByActorId.get(primary.id) ?? null;
      this.scene.environment = texture;
      this.scene.background = texture;
      return;
    }
    this.currentEnvironmentAssetId = null;
    this.scene.environment = null;
  }

  private async loadEnvironmentTexture(
    actor: ActorNode,
    state: AppState,
    assetId: string
  ): Promise<THREE.Texture | null> {
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: "Asset reference not found in project state.",
        updatedAtIso: new Date().toISOString()
      });
      return null;
    }
    const url = await this.kernel.storage.resolveAssetPath({
      projectName: state.activeProjectName,
      relativePath: asset.relativePath
    });
    const extension = asset.relativePath.split(".").pop()?.toLowerCase();
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        format: extension ?? "hdr",
        assetFileName: asset.sourceFileName,
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });
    try {
      const texture = extension === "ktx2"
        ? await new Promise<THREE.Texture>((resolve, reject) => {
            this.ktx2Loader.load(url, resolve, undefined, reject);
          })
        : await new Promise<THREE.Texture>((resolve, reject) => {
            this.rgbeLoader.load(url, resolve, undefined, reject);
          });
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          format: extension ?? "hdr",
          assetFileName: asset.sourceFileName,
          loadState: "loaded"
        },
        updatedAtIso: new Date().toISOString()
      });
      return texture;
    } catch (error) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          format: extension ?? "hdr",
          assetFileName: asset.sourceFileName,
          loadState: "failed"
        },
        error: formatLoadError(error),
        updatedAtIso: new Date().toISOString()
      });
      return null;
    }
  }

  private disposeEnvironmentProbe(actorId: string): void {
    const probeState = this.environmentProbeStateByActorId.get(actorId);
    if (!probeState) {
      return;
    }
    this.replaceEnvironmentTextureReferences(probeState.pmremTarget?.texture ?? null, null);
    this.deferGpuDisposal(probeState.pmremTarget);
    this.deferGpuDisposal(probeState.cubeRenderTarget);
    this.environmentProbeStateByActorId.delete(actorId);
  }

  private deferGpuDisposal(resource: DeferredGpuDisposable | null | undefined): void {
    if (!resource) {
      return;
    }
    this.deferredGpuDisposals.push(resource);
  }

  private replaceEnvironmentTextureReferences(
    previousTexture: THREE.Texture | null,
    nextTexture: THREE.Texture | null
  ): void {
    if (!previousTexture || previousTexture === nextTexture) {
      return;
    }
    if (this.scene.environment === previousTexture) {
      this.scene.environment = nextTexture;
    }
    if (this.scene.background === previousTexture) {
      this.scene.background = nextTexture;
    }
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || typeof material !== "object" || !("envMap" in material)) {
          continue;
        }
        const envMappedMaterial = material as THREE.Material & { envMap?: THREE.Texture | null; needsUpdate?: boolean };
        if (envMappedMaterial.envMap !== previousTexture) {
          continue;
        }
        envMappedMaterial.envMap = nextTexture;
        envMappedMaterial.needsUpdate = true;
      }
    });
  }

  private async syncEnvironmentProbes(state: AppState, orderedActors: ActorNode[]): Promise<void> {
    const activeProbeIds = new Set(
      orderedActors.filter((actor) => actor.actorType === "environment-probe").map((actor) => actor.id)
    );
    for (const existingId of [...this.environmentProbeStateByActorId.keys()]) {
      if (!activeProbeIds.has(existingId)) {
        this.disposeEnvironmentProbe(existingId);
      }
    }
    for (const actor of orderedActors) {
      if (actor.actorType !== "environment-probe") {
        continue;
      }
      this.syncEnvironmentProbePreviewObject(actor);
      const probeState = this.ensureEnvironmentProbeState(actor);
      if (!probeState) {
        this.kernel.store.getState().actions.setActorStatus(actor.id, {
          values: { loadState: "idle" },
          error: this.renderer ? undefined : "Renderer is not ready for environment probe capture.",
          updatedAtIso: new Date().toISOString()
        });
        continue;
      }
      const renderMode = actor.params.renderMode === "never" || actor.params.renderMode === "always"
        ? actor.params.renderMode
        : "on-change";
      const manualToken = typeof actor.params.renderRequestToken === "number" ? actor.params.renderRequestToken : 0;
      const captureSignature = this.buildEnvironmentProbeCaptureSignature(actor, state, manualToken);
      const shouldCapture =
        renderMode === "always"
        || manualToken !== probeState.lastManualToken
        || (renderMode === "on-change" && captureSignature !== probeState.lastCaptureSignature);
      if (!shouldCapture) {
        continue;
      }
      await this.captureEnvironmentProbe(actor, state, probeState, captureSignature, manualToken);
    }
  }

  private ensureEnvironmentProbeState(actor: ActorNode): EnvironmentProbeState | null {
    if (!this.renderer || !this.ensurePmremGenerator()) {
      return null;
    }
    const requestedResolution = typeof actor.params.resolution === "number" ? actor.params.resolution : 256;
    const resolution = Math.max(16, Math.min(2048, Math.round(requestedResolution)));
    const existing = this.environmentProbeStateByActorId.get(actor.id);
    if (existing && existing.cubeRenderTarget.width === resolution) {
      return existing;
    }
    if (existing) {
      this.disposeEnvironmentProbe(actor.id);
    }
    const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(resolution, {
      type: THREE.UnsignedByteType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter
    });
    cubeRenderTarget.texture.colorSpace = THREE.NoColorSpace;
    const cubeCamera = new THREE.CubeCamera(0.01, 1000, cubeRenderTarget);
    cubeCamera.name = `environment-probe-camera:${actor.id}`;
    const probeState: EnvironmentProbeState = {
      cubeCamera,
      cubeRenderTarget,
      pmremTarget: null,
      previewFaceUrls: [],
      lastCaptureSignature: "",
      lastManualToken: 0
    };
    this.environmentProbeStateByActorId.set(actor.id, probeState);
    return probeState;
  }

  private syncEnvironmentProbePreviewObject(actor: ActorNode): void {
    const group = this.actorObjects.get(actor.id);
    if (!(group instanceof THREE.Group)) {
      return;
    }
    const previewMode = actor.params.preview === "cube" ? "cube" : "sphere";
    const existing = group.getObjectByName("environment-probe-preview");
    let mesh = existing as THREE.Mesh | null;
    if (!(mesh instanceof THREE.Mesh)) {
      mesh = new THREE.Mesh(
        previewMode === "cube" ? new THREE.BoxGeometry(1, 1, 1) : new THREE.SphereGeometry(0.5, 24, 16),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          metalness: 1,
          roughness: 0,
          envMapIntensity: 1
        })
      );
      mesh.name = "environment-probe-preview";
      group.add(mesh);
    } else {
      const needsCube = previewMode === "cube";
      const hasCube = mesh.geometry instanceof THREE.BoxGeometry;
      if (needsCube !== hasCube) {
        const nextGeometry = needsCube ? new THREE.BoxGeometry(1, 1, 1) : new THREE.SphereGeometry(0.5, 24, 16);
        mesh.geometry.dispose();
        mesh.geometry = nextGeometry;
      }
    }
    const envTexture = this.environmentProbeStateByActorId.get(actor.id)?.pmremTarget?.texture ?? null;
    if (mesh.material instanceof THREE.MeshStandardMaterial) {
      mesh.material.envMap = envTexture;
      mesh.material.needsUpdate = true;
    }
  }

  private buildEnvironmentProbeCaptureSignature(actor: ActorNode, state: AppState, manualToken: number): string {
    const actorIds = Array.isArray(actor.params.actorIds)
      ? actor.params.actorIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const renderEngine = state.scene.renderEngine;
    const selectedActorSignatures = actorIds
      .map((actorId) => buildEnvironmentProbeSelectedActorSignature(actorId, state))
      .join("|");
    const compatibilitySummary = actorIds
      .map((actorId) => {
        const target = state.actors[actorId];
        if (!target) {
          return `${actorId}:missing`;
        }
        const actorObject = this.actorObjects.get(actorId);
        const reason = environmentProbeCaptureIncompatibilityReason(target, actorObject ?? null, renderEngine);
        return `${actorId}:${reason ?? "ok"}`;
      })
      .join("|");
    return JSON.stringify({
      actor: {
        enabled: actor.enabled,
        transform: actor.transform,
        preview: actor.params.preview,
        resolution: actor.params.resolution,
        renderMode: actor.params.renderMode
      },
      renderEngine,
      actorIds,
      selectedActorSignatures,
      compatibilitySummary,
      manualToken
    });
  }

  private async captureEnvironmentProbe(
    actor: ActorNode,
    state: AppState,
    probeState: EnvironmentProbeState,
    captureSignature: string,
    manualToken: number
  ): Promise<void> {
    const pmremGenerator = this.ensurePmremGenerator();
    if (!this.renderer || !pmremGenerator) {
      return;
    }
    const actorIds = Array.isArray(actor.params.actorIds)
      ? actor.params.actorIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const captureActorIds = new Set(actorIds.filter((actorId) => state.actors[actorId]?.enabled));
    const renderEngine = state.scene.renderEngine;
    const background = this.resolveEnvironmentProbeBackground(actor, captureActorIds, state);
    const previousVisibility = new Map<any, boolean>();
    const skippedActors: Array<{ actorId: string; name: string; reason: string }> = [];
    let compatibleCaptureActorCount = 0;
    const previousBackground = this.scene.background;
    const previousEnvironment = this.scene.environment;
    const renderReason =
      actor.params.renderMode === "always"
        ? "always"
        : manualToken !== probeState.lastManualToken
          ? "manual"
          : "on-change";

    try {
      for (const [actorId, actorObject] of this.actorObjects.entries()) {
        if (!actorObject) {
          continue;
        }
        previousVisibility.set(actorObject, actorObject.visible !== false);
        if (actorId === actor.id) {
          actorObject.visible = false;
          continue;
        }
        const targetActor = state.actors[actorId];
        const incompatibilityReason = targetActor
          ? environmentProbeCaptureIncompatibilityReason(targetActor, actorObject ?? null, renderEngine)
          : null;
        const includeGeometry =
          captureActorIds.has(actorId)
          && targetActor?.enabled !== false
          && targetActor?.actorType !== "environment"
          && targetActor?.actorType !== "environment-probe"
          && incompatibilityReason === null;
        if (
          captureActorIds.has(actorId)
          && targetActor?.enabled !== false
          && targetActor?.actorType !== "environment"
          && targetActor?.actorType !== "environment-probe"
          && incompatibilityReason !== null
        ) {
          skippedActors.push({
            actorId,
            name: targetActor?.name ?? actorId,
            reason: incompatibilityReason
          });
        }
        if (includeGeometry) {
          compatibleCaptureActorCount += 1;
        }
        actorObject.visible = includeGeometry;
      }

      this.scene.background = background.texture;
      this.scene.environment = background.texture;
      probeState.cubeCamera.position.set(...actor.transform.position);
      probeState.cubeCamera.updateMatrixWorld(true);
      this.gaussianSortDirty = true;
      this.hasGaussianCameraState = false;
      this.renderEnvironmentProbeFaces(probeState);
      const previousPmremTarget = probeState.pmremTarget;
      const nextPmremTarget = pmremGenerator.fromCubemap(
        probeState.cubeRenderTarget.texture,
        previousPmremTarget ?? undefined
      );
      probeState.pmremTarget = nextPmremTarget;
      if (previousPmremTarget !== nextPmremTarget || previousPmremTarget?.texture !== nextPmremTarget.texture) {
        this.replaceEnvironmentTextureReferences(previousPmremTarget?.texture ?? null, nextPmremTarget.texture);
        this.deferGpuDisposal(previousPmremTarget);
      }
      probeState.previewFaceUrls = await this.readEnvironmentProbePreviewFaces(probeState);
      probeState.lastCaptureSignature = captureSignature;
      probeState.lastManualToken = manualToken;
      this.syncEnvironmentProbePreviewObject(actor);
      const warning = formatEnvironmentProbeSkippedWarning(
        skippedActors.map((entry) => ({ name: entry.name, reason: entry.reason }))
      );
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          loadState: "captured",
          lastRenderReason: renderReason,
          backgroundSourceName: background.name,
          previewFaces: Object.fromEntries(
            ENVIRONMENT_PROBE_FACE_KEYS.map((key, index) => [key, probeState.previewFaceUrls[index] ?? ""])
          ),
          capturedActorCount: compatibleCaptureActorCount,
          skippedActorCount: skippedActors.length,
          skippedActors: skippedActors.map((entry) => entry.name),
          warning
        },
        updatedAtIso: new Date().toISOString()
      });
    } catch (error) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          loadState: "failed",
          backgroundSourceName: background.name
        },
        error: formatLoadError(error),
        updatedAtIso: new Date().toISOString()
      });
    } finally {
      for (const [actorObject, visible] of previousVisibility.entries()) {
        actorObject.visible = visible;
      }
      this.scene.background = previousBackground;
      this.scene.environment = previousEnvironment;
      this.gaussianSortDirty = true;
      this.hasGaussianCameraState = false;
    }
  }

  private resolveEnvironmentProbeBackground(
    actor: ActorNode,
    captureActorIds: Set<string>,
    state: AppState
  ): EnvironmentSourceResolution {
    const actorPosition = new THREE.Vector3(...actor.transform.position);
    let closest: EnvironmentSourceResolution | null = null;
    let minDistanceSq = Number.POSITIVE_INFINITY;
    for (const actorId of captureActorIds) {
      const candidate = state.actors[actorId];
      if (!candidate || (candidate.actorType !== "environment" && candidate.actorType !== "environment-probe")) {
        continue;
      }
      const resolved = this.resolveEnvironmentSourceByActorId(candidate.id);
      if (!resolved.texture) {
        continue;
      }
      const candidatePosition = new THREE.Vector3(...candidate.transform.position);
      const distanceSq = actorPosition.distanceToSquared(candidatePosition);
      if (distanceSq < minDistanceSq) {
        minDistanceSq = distanceSq;
        closest = resolved;
      }
    }
    return closest ?? { actorId: null, actorType: null, texture: null, name: "none" };
  }

  private renderEnvironmentProbeFaces(probeState: EnvironmentProbeState): void {
    if (!this.renderer) {
      return;
    }
    const renderer = this.renderer as any;
    const cubeCamera = probeState.cubeCamera;
    if (cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
      cubeCamera.coordinateSystem = renderer.coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }
    const currentRenderTarget = renderer.getRenderTarget();
    const currentActiveCubeFace = renderer.getActiveCubeFace();
    const currentActiveMipmapLevel = renderer.getActiveMipmapLevel();
    const currentXrEnabled = renderer.xr.enabled;
    const generateMipmaps = probeState.cubeRenderTarget.texture.generateMipmaps;
    renderer.xr.enabled = false;
    probeState.cubeRenderTarget.texture.generateMipmaps = false;
    const cameras = cubeCamera.children as THREE.PerspectiveCamera[];
    for (let faceIndex = 0; faceIndex < cameras.length; faceIndex += 1) {
      if (faceIndex === cameras.length - 1) {
        probeState.cubeRenderTarget.texture.generateMipmaps = generateMipmaps;
      }
      renderer.setRenderTarget(probeState.cubeRenderTarget, faceIndex, cubeCamera.activeMipmapLevel);
      this.updateGaussianDepthSorting(cameras[faceIndex]);
      renderer.render(this.scene, cameras[faceIndex]);
    }
    renderer.setRenderTarget(currentRenderTarget, currentActiveCubeFace, currentActiveMipmapLevel);
    renderer.xr.enabled = currentXrEnabled;
    probeState.cubeRenderTarget.texture.needsPMREMUpdate = true;
  }

  private ensurePmremGenerator(): SupportedPmremGenerator | null {
    if (this.pmremGenerator) {
      return this.pmremGenerator;
    }
    if (!this.renderer) {
      return null;
    }
    if (this.renderer instanceof THREE.WebGLRenderer) {
      this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      return this.pmremGenerator;
    }
    if (this.renderer instanceof WebGPURenderer) {
      this.pmremGenerator = new WebGpuPMREMGenerator(this.renderer);
      return this.pmremGenerator;
    }
    return null;
  }

  private getWebGpuProbePreviewReadSize(resolution: number): number {
    const cappedSize = Math.min(128, resolution);
    const alignedSize = Math.floor(cappedSize / 64) * 64;
    return alignedSize >= 64 ? alignedSize : 0;
  }

  private resampleEnvironmentProbePixels(
    pixels: ArrayBufferView,
    width: number,
    height: number,
    outputWidth: number,
    outputHeight: number
  ): Uint8Array {
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceContext = sourceCanvas.getContext("2d");
    if (!sourceContext) {
      return new Uint8Array(0);
    }
    const sourceImageData = sourceContext.createImageData(width, height);
    const source = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer.slice(0));
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * width * 4;
      const dstRow = (height - y - 1) * width * 4;
      sourceImageData.data.set(source.subarray(srcRow, srcRow + width * 4), dstRow);
    }
    sourceContext.putImageData(sourceImageData, 0, 0);
    if (width === outputWidth && height === outputHeight) {
      return new Uint8Array(sourceImageData.data);
    }
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) {
      return new Uint8Array(sourceImageData.data);
    }
    outputContext.drawImage(sourceCanvas, 0, 0, outputWidth, outputHeight);
    return new Uint8Array(outputContext.getImageData(0, 0, outputWidth, outputHeight).data);
  }

  private async readEnvironmentProbePreviewFaces(probeState: EnvironmentProbeState): Promise<string[]> {
    if (!this.renderer) {
      return [];
    }
    const previewSize = Math.min(96, probeState.cubeRenderTarget.width);
    const readSize =
      this.renderer instanceof THREE.WebGLRenderer
        ? previewSize
        : this.getWebGpuProbePreviewReadSize(probeState.cubeRenderTarget.width);
    const urls: string[] = [];
    if (readSize <= 0) {
      return urls;
    }
    for (let faceIndex = 0; faceIndex < ENVIRONMENT_PROBE_FACE_KEYS.length; faceIndex += 1) {
      const pixels =
        this.renderer instanceof THREE.WebGLRenderer
          ? await (() => {
              const buffer = new Uint8Array(readSize * readSize * 4);
              return this.renderer!
                .readRenderTargetPixelsAsync(probeState.cubeRenderTarget, 0, 0, readSize, readSize, buffer, faceIndex)
                .then(() => buffer);
            })()
          : await this.renderer.readRenderTargetPixelsAsync(
              probeState.cubeRenderTarget as any,
              0,
              0,
              alignTo(readSize * 4, 256) / 4,
              readSize,
              0,
              faceIndex
            );
      urls.push(
        this.environmentProbePixelsToDataUrl(
          this.resampleEnvironmentProbePixels(pixels, readSize, readSize, previewSize, previewSize),
          previewSize,
          previewSize,
          false
        )
      );
    }
    return urls;
  }

  private environmentProbePixelsToDataUrl(
    pixels: ArrayBufferView,
    width: number,
    height: number,
    flipY = true
  ): string {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return "";
    }
    const imageData = context.createImageData(width, height);
    const source = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer.slice(0));
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * width * 4;
      const dstRow = (flipY ? (height - y - 1) : y) * width * 4;
      imageData.data.set(source.subarray(srcRow, srcRow + width * 4), dstRow);
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }

  private buildAssetUrl(projectName: string, relativePath: string): string {
    return `simularca-asset://${encodeURIComponent(projectName)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
  }

  private loadCachedTexture(url: string, colorSpace: THREE.ColorSpace = THREE.LinearSRGBColorSpace): THREE.Texture {
    if (!this.textureByUrl.has(url)) {
      const tex = this.textureLoader.load(url);
      tex.colorSpace = colorSpace;
      this.textureByUrl.set(url, tex);
    }
    return this.textureByUrl.get(url)!;
  }

  private getMaterial(materialId: string | undefined, actorId: string): THREE.MeshStandardMaterial {
    const state = this.kernel.store.getState().state;
    const localMaterials = state.actors[actorId]?.params.localMaterials as Record<string, unknown> | undefined;
    const materialData = materialId
      ? ((localMaterials?.[materialId] ?? state.materials[materialId]) as typeof state.materials[string] | undefined ?? null)
      : null;

    if (!materialData) {
      return new THREE.MeshStandardMaterial({ color: 0x808080 });
    }

    const mat = materialData as import("@/core/types").Material;
    const materialCacheKey = `${actorId}:${mat.id}`;
    let material = this.materialByMaterialId.get(materialCacheKey);
    if (!material) {
      material = new THREE.MeshStandardMaterial();
      this.materialByMaterialId.set(materialCacheKey, material);
    }

    // Albedo channel
    if (mat.albedo.mode === "color") {
      material.color.set(mat.albedo.color);
      material.map = null;
    } else if (mat.albedo.mode === "image") {
      const asset = state.assets.find((a) => a.id === (mat.albedo as any).assetId && a.kind === "image");
      if (asset) {
        material.map = this.loadCachedTexture(this.buildAssetUrl(state.activeProjectName, asset.relativePath), THREE.SRGBColorSpace);
        material.color.set(0xffffff);
      }
    }

    // Roughness channel
    if (mat.roughness.mode === "scalar") {
      material.roughness = mat.roughness.value;
      material.roughnessMap = null;
    } else if (mat.roughness.mode === "image") {
      const asset = state.assets.find((a) => a.id === (mat.roughness as any).assetId && a.kind === "image");
      if (asset) {
        material.roughnessMap = this.loadCachedTexture(this.buildAssetUrl(state.activeProjectName, asset.relativePath));
        material.roughness = 1;
      }
    }

    // Metalness channel
    if (mat.metalness.mode === "scalar") {
      material.metalness = mat.metalness.value;
      material.metalnessMap = null;
    } else if (mat.metalness.mode === "image") {
      const asset = state.assets.find((a) => a.id === (mat.metalness as any).assetId && a.kind === "image");
      if (asset) {
        material.metalnessMap = this.loadCachedTexture(this.buildAssetUrl(state.activeProjectName, asset.relativePath));
        material.metalness = 1;
      }
    }

    // Normal map
    if (mat.normalMap) {
      const asset = state.assets.find((a) => a.id === (mat.normalMap as any).assetId && a.kind === "image");
      if (asset) {
        material.normalMap = this.loadCachedTexture(this.buildAssetUrl(state.activeProjectName, asset.relativePath));
        material.normalMapType = THREE.TangentSpaceNormalMap;
      }
    } else {
      material.normalMap = null;
    }

    // Emissive channel
    if (mat.emissive.mode === "color") {
      material.emissive.set(mat.emissive.color);
      material.emissiveMap = null;
    } else if (mat.emissive.mode === "image") {
      const asset = state.assets.find((a) => a.id === (mat.emissive as any).assetId && a.kind === "image");
      if (asset) {
        material.emissiveMap = this.loadCachedTexture(this.buildAssetUrl(state.activeProjectName, asset.relativePath), THREE.SRGBColorSpace);
      }
    }
    material.emissiveIntensity = mat.emissiveIntensity;
    material.opacity = mat.opacity;
    material.transparent = mat.transparent;
    material.wireframe = mat.wireframe;
    material.side =
      mat.side === "double"
        ? THREE.DoubleSide
        : mat.side === "back"
          ? THREE.BackSide
          : THREE.FrontSide;

    const env = this.resolveEnvironment(actorId);
    material.envMap = env.texture;
    material.needsUpdate = true;

    return material;
  }

  private getMeshSlotNames(object: any): string[] {
    const slotNames = new Set<string>();
    object.traverse((node: any) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        if (m?.name) slotNames.add(m.name);
      }
    });
    return Array.from(slotNames);
  }

  private applyMeshMaterials(actor: ActorNode, object: any, extension: string): void {
    const DEFAULT_MATERIAL_ID = "mat.plastic.white.glossy";
    const materialOverrideId = typeof actor.params.materialId === "string" ? actor.params.materialId : undefined;
    const materialSlots = (typeof actor.params.materialSlots === "object" && actor.params.materialSlots !== null
      ? actor.params.materialSlots
      : {}) as Record<string, string>;
    const isDae = extension === "dae";
    const env = this.resolveEnvironment(actor.id);

    object.traverse((node: any) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;

      if (materialOverrideId) {
        node.material = Array.isArray(node.material)
          ? node.material.map(() => this.getMaterial(materialOverrideId, actor.id))
          : this.getMaterial(materialOverrideId, actor.id);
      } else if (isDae) {
        // For DAE, apply our material system. Match by Three.js material name; if the name is
        // empty or unrecognised (some exporters omit the name attribute), fall back to the first
        // slot material so imported materials are always applied rather than the default.
        const firstSlotId = Object.values(materialSlots)[0];
        const resolveSlot = (m: any): string =>
          materialSlots[m?.name ?? ""] ?? firstSlotId ?? DEFAULT_MATERIAL_ID;
        node.material = Array.isArray(node.material)
          ? node.material.map((m: any) => this.getMaterial(resolveSlot(m), actor.id))
          : this.getMaterial(resolveSlot(node.material), actor.id);
      } else {
        const applyIfAssigned = (m: any) => {
          const slotId = materialSlots[m?.name ?? ""];
          if (slotId) return this.getMaterial(slotId, actor.id);
          if (m instanceof THREE.MeshStandardMaterial) {
            m.envMap = env.texture;
            m.needsUpdate = true;
          }
          return m;
        };
        node.material = Array.isArray(node.material)
          ? node.material.map(applyIfAssigned)
          : applyIfAssigned(node.material);
      }
    });
  }

  private reapplyMeshMaterials(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) return;
    const renderRoot = object.getObjectByName(MESH_RENDER_ROOT_NAME);
    if (!(renderRoot instanceof THREE.Group) || renderRoot.children.length === 0) return;
    const loadedObject = renderRoot.children[0];
    if (!loadedObject) return;
    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    const extension = asset?.relativePath.split(".").pop()?.toLowerCase() ?? "";
    this.applyMeshMaterials(actor, loadedObject, extension);
  }

  private syncMeshMaterials(actor: ActorNode, state: AppState): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) return;
    const renderRoot = object.getObjectByName(MESH_RENDER_ROOT_NAME);
    if (!(renderRoot instanceof THREE.Group) || renderRoot.children.length === 0) return;

    // Build a signature from material-relevant params and referenced material data
    const materialSlots = actor.params.materialSlots;
    const materialId = actor.params.materialId;
    const referencedMaterialIds = new Set<string>();
    if (typeof materialId === "string" && materialId) referencedMaterialIds.add(materialId);
    if (typeof materialSlots === "object" && materialSlots !== null) {
      for (const v of Object.values(materialSlots as Record<string, unknown>)) {
        if (typeof v === "string" && v) referencedMaterialIds.add(v);
      }
    }
    const localMaterials = actor.params.localMaterials as Record<string, unknown> | undefined;
    const env = this.resolveEnvironment(actor.id);
    const materialHash = Array.from(referencedMaterialIds)
      .sort()
      .map((id) => JSON.stringify(localMaterials?.[id] ?? state.materials[id]))
      .join("|");
    const sig = JSON.stringify({ slots: materialSlots, override: materialId, mats: materialHash, environment: env.actorId });

    if (sig === this.meshMaterialSigByActorId.get(actor.id)) return;
    this.meshMaterialSigByActorId.set(actor.id, sig);
    this.reapplyMeshMaterials(actor);
  }

  private disposeMeshAnimationState(actorId: string): void {
    const animationState = this.meshAnimationStateByActorId.get(actorId);
    if (animationState?.mixer && animationState.rootObject) {
      animationState.mixer.stopAllAction();
      animationState.mixer.uncacheRoot(animationState.rootObject);
    }
    this.meshAnimationStateByActorId.delete(actorId);
    const object = this.actorObjects.get(actorId);
    if (object instanceof THREE.Object3D) {
      delete (object.userData as Record<string, unknown>).meshAnimationInfo;
    }
  }

  private updateMeshAnimationObjectInfo(actorId: string, state: MeshAnimationState | null): void {
    const object = this.actorObjects.get(actorId);
    if (!(object instanceof THREE.Object3D)) {
      return;
    }
    const userData = object.userData as Record<string, unknown>;
    if (!state) {
      delete userData.meshAnimationInfo;
      return;
    }
    userData.meshAnimationInfo = {
      enabled: state.enabled,
      animated: state.enabled && state.activeClipName !== null,
      clipCount: state.clips.length,
      activeClipName: state.activeClipName,
      clipDurationSeconds: state.activeClipDurationSeconds,
      clipTimeSeconds: state.clipTimeSeconds,
      poseRevision: state.poseRevision,
      skinnedMeshCount: state.skinnedMeshCount,
      morphTargetMeshCount: state.morphTargetMeshCount
    };
  }

  private updateMeshAnimationStatus(actorId: string, animationState: MeshAnimationState): void {
    const runtimeStatus = this.kernel.store.getState().state.actorStatusByActorId[actorId];
    const animationStateLabel =
      animationState.clips.length <= 0
        ? "no-clips"
        : animationState.enabled
          ? "playing"
          : "disabled";
    const animationTimeSeconds =
      animationState.clips.length > 0
        ? Number(animationState.clipTimeSeconds.toFixed(3))
        : 0;
    const signature = JSON.stringify({
      animationStateLabel,
      activeClipName: animationState.activeClipName,
      clipCount: animationState.clips.length,
      clipDurationSeconds: Number(animationState.activeClipDurationSeconds.toFixed(3)),
      animationTimeSeconds: Number(animationTimeSeconds.toFixed(1)),
      skinnedMeshCount: animationState.skinnedMeshCount,
      morphTargetMeshCount: animationState.morphTargetMeshCount
    });
    if (signature === animationState.lastStatusSignature) {
      return;
    }
    animationState.lastStatusSignature = signature;
    this.kernel.store.getState().actions.setActorStatus(actorId, {
      values: {
        ...(runtimeStatus?.values ?? {}),
        animationState: animationStateLabel,
        animationClip: animationState.activeClipName ?? "n/a",
        animationClipCount: animationState.clips.length,
        animationDurationSeconds: Number(animationState.activeClipDurationSeconds.toFixed(3)),
        animationTimeSeconds,
        skinnedMeshCount: animationState.skinnedMeshCount,
        morphTargetMeshCount: animationState.morphTargetMeshCount
      },
      error: runtimeStatus?.error,
      updatedAtIso: new Date().toISOString()
    });
  }

  private syncMeshAnimation(actor: ActorNode, simTimeSeconds: number): void {
    const animationState = this.meshAnimationStateByActorId.get(actor.id);
    if (!animationState) {
      return;
    }

    const enabled = Boolean(actor.params.animationEnabled) && animationState.clips.length > 0;
    const requestedClipName =
      typeof actor.params.animationClipName === "string" && actor.params.animationClipName.trim().length > 0
        ? actor.params.animationClipName.trim()
        : null;
    const speed = sanitizeMeshAnimationSpeed(actor.params.animationSpeed);
    const loop = actor.params.animationLoop !== false;
    const startOffsetSeconds = sanitizeMeshAnimationStartOffset(actor.params.animationStartOffsetSeconds);
    const nextClip =
      animationState.clips.find((clip) => clip.name === requestedClipName) ??
      animationState.clips[0] ??
      null;

    if (!nextClip || !animationState.mixer) {
      animationState.enabled = false;
      animationState.action = null;
      animationState.activeClipName = nextClip?.name ?? null;
      animationState.activeClipDurationSeconds = nextClip?.duration ?? 0;
      animationState.clipTimeSeconds = 0;
      this.updateMeshAnimationObjectInfo(actor.id, animationState);
      this.updateMeshAnimationStatus(actor.id, animationState);
      return;
    }

    const previousClipName = animationState.activeClipName;
    if (animationState.activeClipName !== nextClip.name || animationState.action === null) {
      animationState.mixer.stopAllAction();
      const action = animationState.mixer.clipAction(nextClip, animationState.rootObject);
      action.enabled = true;
      action.clampWhenFinished = !loop;
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.play();
      animationState.action = action;
      animationState.activeClipName = nextClip.name;
      animationState.activeClipDurationSeconds = nextClip.duration;
    }

    const previousEnabled = animationState.enabled;
    const previousTimeSeconds = animationState.clipTimeSeconds;
    const nextTimeSeconds = enabled
      ? computeAnimationClipTimeSeconds(
          simTimeSeconds,
          speed,
          startOffsetSeconds,
          animationState.activeClipDurationSeconds,
          loop
        )
      : 0;

    const action = animationState.action;
    action.clampWhenFinished = !loop;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    animationState.enabled = enabled;
    animationState.mixer.setTime(nextTimeSeconds);
    animationState.rootObject.updateMatrixWorld(true);
    animationState.rootObject.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) {
        node.skeleton?.update?.();
      }
    });
    if (
      Math.abs(previousTimeSeconds - nextTimeSeconds) > 1e-6 ||
      previousEnabled !== enabled ||
      previousClipName !== animationState.activeClipName
    ) {
      animationState.poseRevision += 1;
    }
    animationState.clipTimeSeconds = nextTimeSeconds;
    this.updateMeshAnimationObjectInfo(actor.id, animationState);
    this.updateMeshAnimationStatus(actor.id, animationState);
  }

  private createPrimitiveMesh(actor: ActorNode): any {
    const dimensions = this.getPrimitiveDimensions(actor);
    const materialId = typeof actor.params.materialId === "string" ? actor.params.materialId : undefined;
    const mesh = new THREE.Mesh(
      this.createPrimitiveGeometry(
        dimensions.shape,
        dimensions.cubeSize,
        dimensions.sphereRadius,
        dimensions.cylinderRadius,
        dimensions.cylinderHeight,
        dimensions.segments
      ),
      this.getMaterial(materialId, actor.id)
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private syncPrimitiveActor(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const dimensions = this.getPrimitiveDimensions(actor);
    const materialId = typeof actor.params.materialId === "string" ? actor.params.materialId : undefined;
    const wireframe = Boolean(actor.params.wireframe);

    const env = this.resolveEnvironment(actor.id);
    const signature = JSON.stringify({
      ...dimensions,
      materialId,
      wireframe,
      envName: env.name
    });
    const previous = this.primitiveSignatureByActorId.get(actor.id);
    if (signature === previous) {
      return;
    }
    this.primitiveSignatureByActorId.set(actor.id, signature);

    object.geometry = this.createPrimitiveGeometry(
      dimensions.shape,
      dimensions.cubeSize,
      dimensions.sphereRadius,
      dimensions.cylinderRadius,
      dimensions.cylinderHeight,
      dimensions.segments
    );

    object.material = this.getMaterial(materialId, actor.id);
    if (object.material instanceof THREE.MeshStandardMaterial) {
      object.material.wireframe = wireframe;
    }

    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        type: "Primitive",
        shape: dimensions.shape,
        material: actor.params.materialId ?? "Default",
        environment: env.name
      },
      updatedAtIso: new Date().toISOString()
    });
  }

  private syncCurveActor(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) {
      return;
    }
    const line = object.getObjectByName(CURVE_RENDER_LINE_NAME);
    if (!(line instanceof THREE.Line)) {
      return;
    }

    const curveData = curveDataWithOverrides(actor);
    const curveType = curveData.kind === "circle" ? "circle" : "spline";
    const activePoints = curveData.points.filter((point) => point.enabled !== false);
    const samplesPerSegment = getCurveSamplesPerSegmentFromActor(actor);
    const pointCount = activePoints.length;
    const skippedPointCount = Math.max(0, curveData.points.length - activePoints.length);
    const segmentCount = curveType === "circle" ? 1 : pointCount < 2 ? 0 : (curveData.closed ? pointCount : pointCount - 1);
    const signature = JSON.stringify({
      curveData,
      samplesPerSegment
    });
    if (signature === this.curveSignatureByActorId.get(actor.id)) {
      return;
    }
    this.curveSignatureByActorId.set(actor.id, signature);

    const sampled: any[] = [];
    if (curveType === "circle") {
      const totalSamples = Math.max(8, samplesPerSegment);
      for (let sampleIndex = 0; sampleIndex <= totalSamples; sampleIndex += 1) {
        const t = sampleIndex / totalSamples;
        const sample = sampleCurvePositionAndTangent(curveData, t);
        sampled.push(new THREE.Vector3(...sample.position));
      }
    } else if (segmentCount > 0) {
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        const current = activePoints[segmentIndex];
        const next = activePoints[(segmentIndex + 1) % pointCount];
        if (!current || !next) {
          continue;
        }
        const currentHandles = getEffectiveCurveHandlesAt({ kind: "spline", closed: curveData.closed, points: activePoints }, segmentIndex);
        const nextHandles = getEffectiveCurveHandlesAt(
          { kind: "spline", closed: curveData.closed, points: activePoints },
          (segmentIndex + 1) % pointCount
        );
        const p0 = new THREE.Vector3(...current.position);
        const p1 = new THREE.Vector3(
          current.position[0] + currentHandles.handleOut[0],
          current.position[1] + currentHandles.handleOut[1],
          current.position[2] + currentHandles.handleOut[2]
        );
        const p2 = new THREE.Vector3(
          next.position[0] + nextHandles.handleIn[0],
          next.position[1] + nextHandles.handleIn[1],
          next.position[2] + nextHandles.handleIn[2]
        );
        const p3 = new THREE.Vector3(...next.position);
        const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
        const segmentSamples = Math.max(2, samplesPerSegment);
        for (let sampleIndex = 0; sampleIndex <= segmentSamples; sampleIndex += 1) {
          if (segmentIndex > 0 && sampleIndex === 0) {
            continue;
          }
          sampled.push(curve.getPoint(sampleIndex / segmentSamples));
        }
      }
    }

    if (sampled.length < 2) {
      sampled.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.001, 0, 0));
    }

    line.geometry = new THREE.BufferGeometry().setFromPoints(sampled);
    const length = estimateCurveLength(curveData, samplesPerSegment);
    const bounds = new THREE.Box3().setFromPoints(sampled);

    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        pointCount,
        skippedPointCount,
        segmentCount,
        curveType,
        radius: curveType === "circle" ? curveData.radius ?? 1 : null,
        closed: curveData.closed,
        samplesPerSegment,
        length,
        boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
        boundsMax: [bounds.max.x, bounds.max.y, bounds.max.z]
      },
      updatedAtIso: new Date().toISOString()
    });
  }

  private mergeDxfLayerStates(actor: ActorNode, built: BuiltDxfScene): DxfLayerStateMap {
    const current = getDxfLayerStates(actor);
    const next: DxfLayerStateMap = {};
    for (const layer of built.layers) {
      const existing = current[layer.layerName];
      next[layer.layerName] = {
        name: layer.layerName,
        sourceColor: layer.sourceColor,
        color: typeof existing?.color === "string" ? existing.color : layer.sourceColor,
        visible: existing?.visible !== false
      };
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      this.kernel.store.getState().actions.updateActorParamsNoHistory(actor.id, {
        layerStates: next
      });
    }
    return next;
  }

  private clearDxfActor(actor: ActorNode, object: THREE.Group): void {
    const existing = object.getObjectByName(DXF_RENDER_ROOT_NAME);
    if (existing instanceof THREE.Group) {
      disposeDxfObject(existing);
      object.remove(existing);
    }
    this.dxfDocumentByActorId.delete(actor.id);
    this.dxfSceneByActorId.delete(actor.id);
    this.dxfBuildSignatureByActorId.delete(actor.id);
    this.dxfAppearanceSignatureByActorId.delete(actor.id);
    this.dxfStatusSignatureByActorId.delete(actor.id);
  }

  private async syncDxfReferenceAsset(actor: ActorNode): Promise<void> {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) {
      return;
    }
    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
    this.dxfAssetByActorId.set(actor.id, assetId);
    this.dxfReloadTokenByActorId.set(actor.id, reloadToken);

    if (!assetId) {
      this.clearDxfActor(actor, object);
      this.dxfAssetByActorId.delete(actor.id);
      this.dxfReloadTokenByActorId.delete(actor.id);
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.clearDxfActor(actor, object);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: "Asset reference not found in project state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }

    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        assetFileName: asset.sourceFileName,
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });

    try {
      const bytes = await this.kernel.storage.readAssetBytes({
        projectName: state.activeProjectName,
        relativePath: asset.relativePath
      });
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parseDxf(text);
      this.dxfDocumentByActorId.set(actor.id, parsed);
      this.dxfSceneByActorId.delete(actor.id);
      this.dxfBuildSignatureByActorId.delete(actor.id);
      this.dxfAppearanceSignatureByActorId.delete(actor.id);
    } catch (error) {
      this.clearDxfActor(actor, object);
      const message = formatLoadError(error);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          assetFileName: asset.sourceFileName,
          loadState: "failed"
        },
        error: message,
        updatedAtIso: new Date().toISOString()
      });
      this.kernel.store.getState().actions.setStatus(`DXF load failed: ${asset.sourceFileName} (${message})`);
    }
  }

  private syncDxfReferenceVisual(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) {
      return;
    }
    const document = this.dxfDocumentByActorId.get(actor.id);
    if (!document) {
      return;
    }
    const inputUnits = getDxfInputUnits(actor);
    const sourcePlane = getDxfSourcePlane(actor);
    const drawingPlane = getDxfDrawingPlane(actor);
    const curveResolution = getDxfCurveResolution(actor);
    const buildSignature = JSON.stringify({
      assetId: this.dxfAssetByActorId.get(actor.id) ?? "",
      reloadToken: this.dxfReloadTokenByActorId.get(actor.id) ?? 0,
      inputUnits,
      sourcePlane,
      drawingPlane,
      curveResolution
    });

    let built = this.dxfSceneByActorId.get(actor.id);
    if (!built || buildSignature !== this.dxfBuildSignatureByActorId.get(actor.id)) {
      built = buildDxfScene(document, {
        inputUnits,
        sourcePlane,
        drawingPlane,
        curveResolution,
        invertColors: false,
        showText: true
      });
      this.dxfSceneByActorId.set(actor.id, built);
      this.dxfBuildSignatureByActorId.set(actor.id, buildSignature);
      this.dxfAppearanceSignatureByActorId.delete(actor.id);

      const existing = object.getObjectByName(DXF_RENDER_ROOT_NAME);
      if (existing instanceof THREE.Group) {
        disposeDxfObject(existing);
        object.remove(existing);
      }
      const mergedLayerStates = this.mergeDxfLayerStates(actor, built);
      const renderRoot = createDxfObject(built, mergedLayerStates, {
        invertColors: actor.params.invertColors === true,
        showText: actor.params.showText !== false,
        drawingPlane
      });
      renderRoot.name = DXF_RENDER_ROOT_NAME;
      object.add(renderRoot);
    }

    built = this.dxfSceneByActorId.get(actor.id) ?? built;
    if (!built) {
      return;
    }
    const mergedLayerStates = this.mergeDxfLayerStates(actor, built);
    const appearanceSignature = JSON.stringify({
      layerStates: mergedLayerStates,
      invertColors: actor.params.invertColors === true,
      showText: actor.params.showText !== false
    });
    const renderRoot = object.getObjectByName(DXF_RENDER_ROOT_NAME);
    let visibleLayerCount = Object.keys(mergedLayerStates).length;
    const appearanceChanged = appearanceSignature !== this.dxfAppearanceSignatureByActorId.get(actor.id);
    if (renderRoot instanceof THREE.Group && appearanceChanged) {
      visibleLayerCount = syncDxfAppearance(renderRoot, mergedLayerStates, {
        invertColors: actor.params.invertColors === true,
        showText: actor.params.showText !== false
      });
      this.dxfAppearanceSignatureByActorId.set(actor.id, appearanceSignature);
    } else {
      visibleLayerCount = Object.values(mergedLayerStates).filter((entry) => entry.visible !== false).length;
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const asset = this.kernel.store.getState().state.assets.find((entry) => entry.id === assetId);
    const unsupportedEntries = Object.entries(built.unsupportedEntityCounts);
    const statusValues = {
      assetFileName: asset?.sourceFileName ?? "",
      loadState: "loaded",
      units: inputUnits,
      sourcePlane,
      resolvedSourcePlane: built.resolvedSourcePlane,
      sourcePlaneMode: built.sourcePlaneMode,
      plane: drawingPlane,
      layerCount: built.layers.length,
      visibleLayerCount,
      entityCount: built.entityCount,
      segmentCount: built.segmentCount,
      textCount: built.textCount,
      boundsMin: built.bounds?.min ?? null,
      boundsMax: built.bounds?.max ?? null,
      unsupportedEntityCount: unsupportedEntries.reduce((sum, [, count]) => sum + count, 0),
      unsupportedEntityCounts: unsupportedEntries.length > 0
        ? unsupportedEntries.map(([name, count]) => `${name}:${count}`).join(", ")
        : null,
      unsupportedEntityTypes: unsupportedEntries.map(([name, count]) => `${name}:${count}`),
      warnings: built.warnings,
      layerOrder: built.layerOrder
    };
    const statusSignature = JSON.stringify(statusValues);
    if (statusSignature !== this.dxfStatusSignatureByActorId.get(actor.id)) {
      this.dxfStatusSignatureByActorId.set(actor.id, statusSignature);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: statusValues,
        updatedAtIso: new Date().toISOString()
      });
    }
  }

  private applyActorTransform(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!object) {
      return;
    }
    const selection = this.kernel.store.getState().state.selection;
    const isSelected = selection.some((entry) => entry.kind === "actor" && entry.id === actor.id);
    object.visible =
      computeActorObjectVisibility(actor, isSelected, this.debugHelpersVisible) &&
      this.isActorPluginEnabled(actor);
    object.position.set(...actor.transform.position);
    object.rotation.set(...actor.transform.rotation);
    object.scale.set(...actor.transform.scale);
    if (actor.actorType === "mesh" && object instanceof THREE.Group) {
      const renderRoot = object.getObjectByName(MESH_RENDER_ROOT_NAME);
      if (renderRoot instanceof THREE.Group) {
        const scaleFactor = Number(actor.params.scaleFactor ?? 1);
        const safe = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        renderRoot.scale.setScalar(safe);
      }
    }
  }

  public async syncGaussianSplatAsset(actor: ActorNode): Promise<void> {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) {
      return;
    }
    const correctedRoot = object.getObjectByName(GAUSSIAN_RENDER_ROOT_NAME);
    if (!(correctedRoot instanceof THREE.Group)) {
      return;
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
    const previousAssetId = this.gaussianAssetByActorId.get(actor.id) ?? "";
    const previousReloadToken = this.gaussianReloadTokenByActorId.get(actor.id) ?? 0;
    if (assetId === previousAssetId && reloadToken === previousReloadToken) {
      const geometry = this.gaussianGeometryByActorId.get(actor.id);
      if (geometry) {
        this.syncGaussianFallbackVisual(actor, correctedRoot, geometry);
      }
      return;
    }
    this.gaussianAssetByActorId.set(actor.id, assetId);
    this.gaussianReloadTokenByActorId.set(actor.id, reloadToken);
    if (!assetId) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      const existing = correctedRoot.getObjectByName(GAUSSIAN_RENDER_MESH_NAME);
      if (existing) {
        correctedRoot.remove(existing);
      }
      const helper = this.gaussianBoundsHelpers.get(actor.id);
      if (helper) {
        correctedRoot.remove(helper);
        this.gaussianBoundsHelpers.delete(actor.id);
      }
      this.gaussianGeometryByActorId.delete(actor.id);
      this.gaussianVisualSignatureByActorId.delete(actor.id);
      this.gaussianVisibleCountByActorId.delete(actor.id);
      this.gaussianTriangleCountByActorId.delete(actor.id);
      this.gaussianSortableBatchesByActorId.delete(actor.id);
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          backend: "native-in-scene",
          loader: "splatbin-v1",
          loaderVersion: THREE.REVISION
        },
        error: "Asset reference not found in project state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        backend: "native-in-scene",
        loader: "splatbin-v1",
        loaderVersion: THREE.REVISION,
        encoding: asset.encoding ?? "raw",
        assetFileName: asset.sourceFileName,
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });
    try {
      const rawBytes = await this.kernel.storage.readAssetBytes({
        projectName: state.activeProjectName,
        relativePath: asset.relativePath
      });
      const parsed = tryParseSplatBinary(rawBytes);
      const geometryBytes = parsed?.payload ?? rawBytes;
      const parseInput = geometryBytes.buffer.slice(
        geometryBytes.byteOffset,
        geometryBytes.byteOffset + geometryBytes.byteLength
      );
      const vertexPropertyNames = extractPlyVertexPropertyNames(geometryBytes);
      const gaussianPropertyCandidates = [
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "dc_0",
        "dc_1",
        "dc_2",
        "opacity",
        "alpha",
        "scale_0",
        "scale_1",
        "scale_2",
        "sx",
        "sy",
        "sz",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3"
      ];
      const customPropertyMapping: Record<string, string[]> = {};
      for (const name of gaussianPropertyCandidates) {
        if (vertexPropertyNames.has(name)) {
          customPropertyMapping[name] = [name];
        }
      }
      this.plyLoader.setCustomPropertyNameMapping(customPropertyMapping);
      const geometry = (this.plyLoader as any).parse(parseInput);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const position = geometry.getAttribute("position");
      const pointCount = position?.count ?? 0;
      const bounds = geometry.boundingBox;
      const attributeNames = Object.keys((geometry?.attributes as Record<string, unknown> | undefined) ?? {});
      const fdc0Attr = getAttribute(geometry, ["f_dc_0", "dc_0", "f_dc0"]);
      const fdc1Attr = getAttribute(geometry, ["f_dc_1", "dc_1", "f_dc1"]);
      const fdc2Attr = getAttribute(geometry, ["f_dc_2", "dc_2", "f_dc2"]);
      const scale0Attr = getAttribute(geometry, ["scale_0", "sx"]);
      const scale1Attr = getAttribute(geometry, ["scale_1", "sy"]);
      const scale2Attr = getAttribute(geometry, ["scale_2", "sz"]);
      const rot0Attr = getAttribute(geometry, ["rot_0", "r_0"]);
      const rot1Attr = getAttribute(geometry, ["rot_1", "r_1"]);
      const rot2Attr = getAttribute(geometry, ["rot_2", "r_2"]);
      const rot3Attr = getAttribute(geometry, ["rot_3", "r_3"]);
      const opacityAttr = getAttribute(geometry, ["opacity", "alpha", "a"]);
      const loaderDebugValues = {
        hasFdc: Boolean(fdc0Attr && fdc1Attr && fdc2Attr),
        hasScale: Boolean(scale0Attr && scale1Attr && scale2Attr),
        hasRotation: Boolean(rot0Attr && rot1Attr && rot2Attr && rot3Attr),
        hasOpacity: Boolean(opacityAttr),
        scale0Range: readAttributeRange(scale0Attr),
        scale1Range: readAttributeRange(scale1Attr),
        scale2Range: readAttributeRange(scale2Attr),
        opacityRange: readAttributeRange(opacityAttr)
      };
      this.gaussianGeometryByActorId.set(actor.id, geometry);
      this.gaussianVisualSignatureByActorId.delete(actor.id);
      this.syncGaussianFallbackVisual(actor, correctedRoot, geometry);
      const renderMesh = correctedRoot.getObjectByName(GAUSSIAN_RENDER_MESH_NAME) as any;
      const colorDebug = renderMesh?.userData?.colorDebug as
        | { source?: string; colorSpread?: number; colorDenominator?: number; averageColor?: [number, number, number] }
        | undefined;
      const colorDebugValues = colorDebug
        ? {
            colorSource: colorDebug.source ?? "unknown",
            colorSpread: colorDebug.colorSpread ?? 0,
            colorDenominator: colorDebug.colorDenominator ?? 1,
            averageColor: colorDebug.averageColor ?? [0, 0, 0],
            attributes: attributeNames.length > 0 ? attributeNames.join(", ") : "none",
            ...loaderDebugValues
          }
        : {};

      if (bounds) {
        const correctedBounds = correctedBoundsForViewport(bounds);
        const min = `${correctedBounds.min.x.toFixed(3)}, ${correctedBounds.min.y.toFixed(3)}, ${correctedBounds.min.z.toFixed(3)}`;
        const max = `${correctedBounds.max.x.toFixed(3)}, ${correctedBounds.max.y.toFixed(3)}, ${correctedBounds.max.z.toFixed(3)}`;
        let helper = this.gaussianBoundsHelpers.get(actor.id);
        if (!helper) {
          helper = new THREE.Box3Helper(correctedBounds.clone(), 0xff5bd6);
          helper.visible = this.debugHelpersVisible;
          this.gaussianBoundsHelpers.set(actor.id, helper);
          correctedRoot.add(helper);
        } else {
          helper.box.copy(correctedBounds);
        }
        this.kernel.store
          .getState()
          .actions.setStatus(
            `Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount} | bounds: [${min}] -> [${max}]`
          );
        this.kernel.store.getState().actions.setActorStatus(actor.id, {
          values: {
            backend: "native-in-scene",
            loader: "splatbin-v1",
            loaderVersion: THREE.REVISION,
            encoding: parsed ? "splatbin-v1" : (asset.encoding ?? "raw"),
            assetFileName: asset.sourceFileName,
            loadState: "loaded",
            pointCount,
            boundsMin: [correctedBounds.min.x, correctedBounds.min.y, correctedBounds.min.z],
            boundsMax: [correctedBounds.max.x, correctedBounds.max.y, correctedBounds.max.z],
            ...colorDebugValues
          },
          updatedAtIso: new Date().toISOString()
        });
      } else {
        this.kernel.store
          .getState()
          .actions.setStatus(`Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount}`);
        this.kernel.store.getState().actions.setActorStatus(actor.id, {
          values: {
            backend: "native-in-scene",
            loader: "splatbin-v1",
            loaderVersion: THREE.REVISION,
            encoding: parsed ? "splatbin-v1" : (asset.encoding ?? "raw"),
            assetFileName: asset.sourceFileName,
            loadState: "loaded",
            pointCount,
            ...colorDebugValues
          },
          updatedAtIso: new Date().toISOString()
        });
      }
    } catch (error) {
      const errorMessage = formatLoadError(error);
      this.gaussianGeometryByActorId.delete(actor.id);
      this.gaussianVisualSignatureByActorId.delete(actor.id);
      this.gaussianVisibleCountByActorId.delete(actor.id);
      this.gaussianTriangleCountByActorId.delete(actor.id);
      this.gaussianSortableBatchesByActorId.delete(actor.id);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          backend: "native-in-scene",
          loader: "splatbin-v1",
          loaderVersion: THREE.REVISION,
          encoding: asset.encoding ?? "raw",
          assetFileName: asset.sourceFileName,
          loadState: "failed"
        },
        error: errorMessage,
        updatedAtIso: new Date().toISOString()
      });
      this.kernel.store
        .getState()
        .actions.setStatus(`Gaussian splat load failed: ${asset.sourceFileName} (${errorMessage})`);
    }
  }

  private async syncMeshAsset(actor: ActorNode): Promise<void> {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Group)) {
      return;
    }
    const renderRoot = object.getObjectByName(MESH_RENDER_ROOT_NAME);
    if (!(renderRoot instanceof THREE.Group)) {
      return;
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
    const previousAssetId = this.meshAssetByActorId.get(actor.id) ?? "";
    const previousReloadToken = this.meshReloadTokenByActorId.get(actor.id) ?? 0;
    if (assetId === previousAssetId && reloadToken === previousReloadToken) {
      return; // early exit Ã¢â‚¬â€ expected on every frame after the first load
    }
    this.meshAssetByActorId.set(actor.id, assetId);
    this.meshReloadTokenByActorId.set(actor.id, reloadToken);
    this.disposeMeshAnimationState(actor.id);

    renderRoot.clear();

    if (!assetId) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setStatus("Mesh asset reference not found in project state.");
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: "Asset reference not found in project state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }

    const extension = asset.relativePath.split(".").pop()?.toLowerCase() ?? "";
    // Build the asset URL locally Ã¢â‚¬â€ no IPC round-trip needed.
    const encodedProject = encodeURIComponent(state.activeProjectName);
    const encodedPath = asset.relativePath
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => encodeURIComponent(part))
      .join("/");
    const url = `simularca-asset://${encodedProject}/${encodedPath}`;
    // Defer "loading" status to a macrotask so the React re-render (useSyncExternalStore) does
    // not queue a microtask that runs before syncFromState's continuation microtask.
    const actorIdForLoading = actor.id;
    setTimeout(() => {
      this.kernel.store.getState().actions.setActorStatus(actorIdForLoading, {
        values: {
          format: extension || "unknown",
          assetFileName: asset.sourceFileName,
          loadState: "loading"
        },
        updatedAtIso: new Date().toISOString()
      });
    }, 0);

    const loadToken = (this.meshLoadTokenByActorId.get(actor.id) ?? 0) + 1;
    this.meshLoadTokenByActorId.set(actor.id, loadToken);

    const attachLoaded = (loadedObject: any, animations?: THREE.AnimationClip[]) => {
      if (this.meshLoadTokenByActorId.get(actor.id) !== loadToken) {
        return;
      }
      renderRoot.clear();
      renderRoot.add(loadedObject);
      this.applyMeshMaterials(actor, loadedObject, extension);
      const bounds = new THREE.Box3().setFromObject(loadedObject);
      const size = new THREE.Vector3();
      bounds.getSize(size);
      let meshCount = 0;
      let triangleCount = 0;
      loadedObject.traverse((node: any) => {
        if (!(node instanceof THREE.Mesh)) {
          return;
        }
        meshCount += 1;
        const geometry = node.geometry;
        const indexCount = geometry?.index?.count;
        const positionCount = geometry?.attributes?.position?.count;
        if (typeof indexCount === "number" && indexCount > 0) {
          triangleCount += Math.floor(indexCount / 3);
          return;
        }
        if (typeof positionCount === "number" && positionCount > 0) {
          triangleCount += Math.floor(positionCount / 3);
        }
      });
      const clips = Array.isArray(animations)
        ? animations
        : Array.isArray((loadedObject as { animations?: unknown }).animations)
          ? ((loadedObject as { animations?: THREE.AnimationClip[] }).animations ?? [])
          : [];
      const { skinnedMeshCount, morphTargetMeshCount } = countAnimatedMeshFeatures(loadedObject);
      const animationState: MeshAnimationState = {
        rootObject: loadedObject,
        clips,
        mixer: clips.length > 0 ? new THREE.AnimationMixer(loadedObject) : null,
        action: null,
        activeClipName: clips[0]?.name ?? null,
        activeClipDurationSeconds: clips[0]?.duration ?? 0,
        enabled: false,
        clipTimeSeconds: 0,
        poseRevision: 0,
        skinnedMeshCount,
        morphTargetMeshCount,
        lastStatusSignature: ""
      };
      this.meshAnimationStateByActorId.set(actor.id, animationState);
      this.syncMeshAnimation(
        actor,
        Number.isFinite(state.time.elapsedSimSeconds) ? state.time.elapsedSimSeconds : 0
      );
      const meshAnimationInfo = (this.actorObjects.get(actor.id)?.userData as Record<string, unknown> | undefined)?.meshAnimationInfo as
        | Record<string, unknown>
        | undefined;
      const slotNames = this.getMeshSlotNames(loadedObject);
      const env = this.resolveEnvironment(actor.id);
      // Defer Zustand status dispatches to a macrotask (setTimeout). Without this, Zustand's
      // set() triggers a synchronous React re-render (useSyncExternalStore) as a microtask that
      // runs BEFORE syncFromState's continuation microtask, causing the render loop to block for
      // ~2-3 seconds while React renders the 100-slot inspector.
      const boundsMin: [number, number, number] = [bounds.min.x, bounds.min.y, bounds.min.z];
      const boundsMax: [number, number, number] = [bounds.max.x, bounds.max.y, bounds.max.z];
      const sizeArr: [number, number, number] = [size.x, size.y, size.z];
      const actorId = actor.id;
      const statusMsg = `Mesh loaded: ${asset.sourceFileName} (${extension || "unknown"}) | size (m): ${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}`;
      setTimeout(() => {
        this.kernel.store.getState().actions.setActorStatus(actorId, {
          values: {
            format: extension || "unknown",
            assetFileName: asset.sourceFileName,
            loadState: "loaded",
            meshCount,
            triangleCount,
            animationState: meshAnimationInfo?.enabled ? "playing" : clips.length > 0 ? "disabled" : "no-clips",
            animationClip: meshAnimationInfo?.activeClipName ?? clips[0]?.name ?? "n/a",
            animationClipCount: clips.length,
            animationDurationSeconds: Number((clips[0]?.duration ?? 0).toFixed(3)),
            animationTimeSeconds: Number((Number(meshAnimationInfo?.clipTimeSeconds ?? 0)).toFixed(3)),
            skinnedMeshCount,
            morphTargetMeshCount,
            boundsMin,
            boundsMax,
            size: sizeArr,
            materialSlotNames: slotNames,
            environment: env.name
          },
          updatedAtIso: new Date().toISOString()
        });
        this.kernel.store.getState().actions.setStatus(statusMsg);
      }, 0);
    };

    const onError = (error: unknown) => {
      console.error("[simularca] ColladaLoader error for", url, error);
      const message = formatLoadError(error);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          format: extension || "unknown",
          assetFileName: asset.sourceFileName,
          loadState: "failed"
        },
        error: message,
        updatedAtIso: new Date().toISOString()
      });
      this.kernel.store.getState().actions.setStatus(`Mesh load failed: ${asset.sourceFileName} (${message})`);
    };

    try {
      if (extension === "glb" || extension === "gltf") {
        this.gltfLoader.load(
          url,
          (result: any) => {
            attachLoaded(result.scene, Array.isArray(result.animations) ? result.animations : []);
          },
          undefined,
          onError
        );
        return;
      }
      if (extension === "fbx") {
        this.fbxLoader.load(
          url,
          (fbx: any) => {
            attachLoaded(fbx, Array.isArray(fbx?.animations) ? fbx.animations : []);
          },
          undefined,
          onError
        );
        return;
      }
      if (extension === "dae") {
        this.colladaLoader.load(
          url,
          (result: any) => {
            attachLoaded(result.scene);
          },
          undefined,
          onError
        );
        return;
      }
      if (extension === "obj") {
        this.objLoader.load(
          url,
          (obj: any) => {
            attachLoaded(obj);
          },
          undefined,
          onError
        );
        return;
      }
      this.kernel.store
        .getState()
        .actions.setStatus(`Unsupported mesh format: .${extension}. Supported: glb, gltf, fbx, dae, obj`);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          format: extension || "unknown",
          assetFileName: asset.sourceFileName
        },
        error: "Unsupported mesh format. Supported: glb, gltf, fbx, dae, obj",
        updatedAtIso: new Date().toISOString()
      });
    } catch (error) {
      onError(error);
    }
  }

  private syncGaussianFallbackVisual(actor: ActorNode, correctedRoot: any, geometry: any): void {
    const opacity = Number(actor.params.opacity ?? 1);
    const splatSize = Number(actor.params.splatSize ?? 1);
    const safeSplatSize = Number.isFinite(splatSize) && splatSize > 0 ? splatSize : 1;
    const pointSize = this.suggestGaussianPointSize(geometry);
    const filterSpec = this.buildGaussianFilterSpec(actor);
    const visualSignature = JSON.stringify({
      opacity: Number.isFinite(opacity) ? opacity : 1,
      pointSize,
      splatSize: safeSplatSize,
      filterSpec
    });
    const previous = this.gaussianVisualSignatureByActorId.get(actor.id);
    if (visualSignature === previous) {
      return;
    }
    this.gaussianVisualSignatureByActorId.set(actor.id, visualSignature);
    const existing = correctedRoot.getObjectByName(GAUSSIAN_RENDER_MESH_NAME);
    if (existing) {
      correctedRoot.remove(existing);
    }
    const renderMesh = this.buildGaussianFallbackMesh(geometry, pointSize, safeSplatSize, opacity, filterSpec);
    renderMesh.name = GAUSSIAN_RENDER_MESH_NAME;
    correctedRoot.add(renderMesh);
    this.gaussianVisibleCountByActorId.set(actor.id, Number(renderMesh.userData?.visibleCount ?? 0));
    this.gaussianTriangleCountByActorId.set(actor.id, Number(renderMesh.userData?.triangleCount ?? 0));
    const sortableBatch = renderMesh.userData?.sortableBatch as GaussianSortableBatch | undefined;
    if (sortableBatch) {
      sortableBatch.actorId = actor.id;
      this.gaussianSortableBatchesByActorId.set(actor.id, sortableBatch);
    } else {
      this.gaussianSortableBatchesByActorId.delete(actor.id);
    }
    this.gaussianSortDirty = true;
  }

  private suggestGaussianPointSize(geometry: any): number {
    const bounds = geometry.boundingBox;
    if (!bounds) {
      return 0.02;
    }
    const correctedBounds = correctedBoundsForViewport(bounds);
    const maxExtent = Math.max(
      correctedBounds.max.x - correctedBounds.min.x,
      correctedBounds.max.y - correctedBounds.min.y,
      correctedBounds.max.z - correctedBounds.min.z
    );
    return Math.max(0.02, Math.min(0.25, maxExtent / 1200));
  }

  private buildGaussianFilterSpec(actor: ActorNode): GaussianFallbackFilterSpec | null {
    const state = this.kernel.store.getState().state;
    const mode = getGaussianFilterMode(actor);
    if (mode === "off") {
      return null;
    }
    const regionIds = getGaussianFilterRegionActorIds(actor);
    if (regionIds.length === 0) {
      return null;
    }

    const gaussianWorld = this.resolveActorWorldMatrix(actor.id, state.actors);
    const correctionMatrix = new THREE.Matrix4().makeRotationFromQuaternion(SPLAT_COORDINATE_CORRECTION_QUATERNION);
    const gaussianLocalToWorld = gaussianWorld.clone().multiply(correctionMatrix);
    const worldToGaussianLocal = gaussianLocalToWorld.clone().invert();
    const regions: GaussianFallbackFilterRegion[] = [];

    for (const regionId of regionIds) {
      const regionActor = state.actors[regionId];
      if (!regionActor || !regionActor.enabled || regionActor.actorType !== "primitive") {
        continue;
      }
      const shape = typeof regionActor.params.shape === "string" ? regionActor.params.shape : "cube";
      if (shape !== "sphere" && shape !== "cube" && shape !== "cylinder") {
        continue;
      }
      const cubeSizeRaw = Number(regionActor.params.cubeSize ?? 1);
      const sphereRadiusRaw = Number(regionActor.params.sphereRadius ?? 0.5);
      const cylinderRadiusRaw = Number(regionActor.params.cylinderRadius ?? 0.5);
      const cylinderHeightRaw = Number(regionActor.params.cylinderHeight ?? 1);
      const safeCubeSize = Number.isFinite(cubeSizeRaw) && cubeSizeRaw >= 0 ? cubeSizeRaw : 1;
      const safeSphereRadius = Number.isFinite(sphereRadiusRaw) && sphereRadiusRaw >= 0 ? sphereRadiusRaw : 0.5;
      const safeCylinderRadius = Number.isFinite(cylinderRadiusRaw) && cylinderRadiusRaw >= 0 ? cylinderRadiusRaw : 0.5;
      const safeCylinderHeight = Number.isFinite(cylinderHeightRaw) && cylinderHeightRaw >= 0 ? cylinderHeightRaw : 1;
      const primitiveWorld = this.resolveActorWorldMatrix(regionActor.id, state.actors);
      const primitiveToGaussianLocal = worldToGaussianLocal.clone().multiply(primitiveWorld);
      const gaussianLocalToPrimitive = primitiveToGaussianLocal.clone().invert();
      regions.push({
        actorId: regionActor.id,
        shape,
        radius: shape === "sphere" ? safeSphereRadius : shape === "cylinder" ? safeCylinderRadius : safeCubeSize * 0.5,
        height: shape === "cylinder" ? safeCylinderHeight : safeCubeSize,
        worldMatrixElements: primitiveWorld.elements.map((value: number) => Number(value.toFixed(6))),
        gaussianLocalToPrimitive
      });
    }

    if (regions.length === 0) {
      return null;
    }

    return { mode, regions };
  }

  private isGaussianPointVisible(
    positionInGaussianLocal: any,
    filterSpec: GaussianFallbackFilterSpec,
    tempLocal: any
  ): boolean {
    let insideAnyRegion = false;
    for (const region of filterSpec.regions) {
      if (this.isPointInsideFilterRegion(positionInGaussianLocal, region, tempLocal)) {
        insideAnyRegion = true;
        break;
      }
    }
    return filterSpec.mode === "inside" ? insideAnyRegion : !insideAnyRegion;
  }

  private isPointInsideFilterRegion(
    positionInGaussianLocal: any,
    region: GaussianFallbackFilterRegion,
    target: any
  ): boolean {
    const local = target.copy(positionInGaussianLocal).applyMatrix4(region.gaussianLocalToPrimitive);
    if (region.shape === "sphere") {
      return local.lengthSq() <= region.radius * region.radius;
    }
    if (region.shape === "cube") {
      const halfSize = region.height * 0.5;
      return (
        Math.abs(local.x) <= halfSize &&
        Math.abs(local.y) <= halfSize &&
        Math.abs(local.z) <= halfSize
      );
    }
    const radiusSq = local.x * local.x + local.z * local.z;
    return radiusSq <= region.radius * region.radius && Math.abs(local.y) <= region.height * 0.5;
  }

  private resolveActorWorldMatrix(actorId: string, actors: Record<string, ActorNode>): any {
    const chain: ActorNode[] = [];
    const visited = new Set<string>();
    let cursor: ActorNode | undefined = actors[actorId];
    while (cursor) {
      if (visited.has(cursor.id)) {
        break;
      }
      visited.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentActorId ? actors[cursor.parentActorId] : undefined;
    }
    const worldMatrix = MATRIX_IDENTITY.clone();
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const actor = chain[index];
      if (!actor) {
        continue;
      }
      worldMatrix.multiply(this.actorLocalMatrix(actor.transform));
    }
    return worldMatrix;
  }

  private isActorPluginEnabled(actor: ActorNode): boolean {
    if (actor.actorType !== "plugin") {
      return true;
    }
    const plugin = resolveActorPlugin(actor, this.kernel.pluginApi.listPlugins());
    if (!plugin) {
      return true;
    }
    const state = this.kernel.store.getState().state;
    return isPluginEnabled(state.pluginsEnabled, plugin.definition.id);
  }

  private resolveActorDescriptor(actor: ActorNode): ReloadableDescriptor | null {
    const descriptors = this.kernel.descriptorRegistry.listByKind("actor");
    for (const descriptor of descriptors) {
      if (!descriptor.spawn) {
        continue;
      }
      if (descriptor.spawn.actorType !== actor.actorType) {
        continue;
      }
      if (descriptor.spawn.pluginType !== actor.pluginType) {
        continue;
      }
      return descriptor;
    }
    return null;
  }

  private setMissingPluginStatus(actor: ActorNode): void {
    if (actor.actorType !== "plugin") {
      return;
    }
    const pluginType = typeof actor.pluginType === "string" && actor.pluginType.trim().length > 0 ? actor.pluginType : "unknown";
    const reason = `Plugin actor type is unavailable: ${pluginType}`;
    const current = this.kernel.store.getState().state.actorStatusByActorId[actor.id];
    if (current?.values?.pluginMissing === true && current.values.pluginMissingReason === reason) {
      return;
    }
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        pluginMissing: true,
        pluginMissingReason: reason,
        pluginType
      },
      updatedAtIso: new Date().toISOString()
    });
  }

  private clearMissingPluginStatus(actor: ActorNode): void {
    const current = this.kernel.store.getState().state.actorStatusByActorId[actor.id];
    if (current?.values?.pluginMissing !== true) {
      return;
    }
    const nextValues = { ...current.values };
    delete nextValues.pluginMissing;
    delete nextValues.pluginMissingReason;
    delete nextValues.pluginType;
    const hasValues = Object.keys(nextValues).length > 0;
    this.kernel.store.getState().actions.setActorStatus(
      actor.id,
      hasValues
        ? {
            ...current,
            values: nextValues,
            updatedAtIso: new Date().toISOString()
          }
        : null
    );
  }

  private createPluginSceneObject(actor: ActorNode): any | null {
    if (actor.actorType !== "plugin") {
      return null;
    }
    const descriptor = this.resolveActorDescriptor(actor);
    if (!descriptor?.sceneHooks?.createObject) {
      if (!descriptor) {
        this.setMissingPluginStatus(actor);
      }
      return null;
    }
    this.clearMissingPluginStatus(actor);
    try {
      const created = descriptor.sceneHooks.createObject({
        actor,
        state: this.kernel.store.getState().state
      });
      if (created) {
        return created;
      }
    } catch (error) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: `Plugin createObject failed: ${formatLoadError(error)}`,
        updatedAtIso: new Date().toISOString()
      });
    }
    return null;
  }

  private disposePluginSceneObject(
    actor: ActorNode | null,
    object: unknown,
    descriptorOverride?: ReloadableDescriptor
  ): void {
    if (!actor || !object) {
      return;
    }
    const descriptor = descriptorOverride ?? this.resolveActorDescriptor(actor);
    if (!descriptor?.sceneHooks?.disposeObject) {
      return;
    }
    try {
      descriptor.sceneHooks.disposeObject({
        actor,
        state: this.kernel.store.getState().state,
        object
      });
    } catch (error) {
      this.kernel.store.getState().actions.addLog({
        level: "warn",
        message: `Plugin disposeObject failed for actor ${actor.name}`,
        details: formatLoadError(error)
      });
    }
  }

  private syncPluginSceneActor(actor: ActorNode, state: AppState, simTimeSeconds: number, dtSeconds: number): void {
    if (actor.actorType !== "plugin") {
      return;
    }
    const descriptor = this.resolveActorDescriptor(actor);
    if (!descriptor) {
      this.setMissingPluginStatus(actor);
      return;
    }
    this.clearMissingPluginStatus(actor);
    if (!descriptor.sceneHooks?.syncObject) {
      return;
    }
    const object = this.actorObjects.get(actor.id);
    if (!object) {
      return;
    }
    try {
      const syncPluginObject = () =>
        descriptor.sceneHooks!.syncObject!({
          actor,
          state,
          object,
          runtime: this.pluginActorRuntimeController.getRuntime(actor.id),
          simTimeSeconds,
          dtSeconds,
          getActorById: (actorId) => this.kernel.store.getState().state.actors[actorId] ?? null,
          getActorObject: (actorId) => this.actorObjects.get(actorId) ?? null,
          getActorRuntime: (actorId) => this.pluginActorRuntimeController.getRuntime(actorId),
          sampleCurveWorldPoint: (actorId, t) => this.sampleCurveWorldPoint(actorId, t),
          getMistVolumeResource: (actorId) => this.mistVolumeController.getResource(actorId),
          getVolumetricRayResource: (actorId) => this.pluginActorRuntimeController.getVolumetricResource(actorId),
          profileChunk: <T,>(label: string, run: () => T): T => this.kernel.profiler.withChunk(label, run),
          setActorStatus: (status: ActorRuntimeStatus | null) => {
            this.kernel.store.getState().actions.setActorStatus(actor.id, status);
          },
          readAssetBytes: (assetId: string): Promise<Uint8Array> => {
            const asset = state.assets.find(a => a.id === assetId);
            if (!asset) {
              return Promise.reject(new Error(`Asset not found: ${assetId}`));
            }
            return this.kernel.storage.readAssetBytes({
              projectName: state.activeProjectName,
              relativePath: asset.relativePath
            });
          }
        });
      if (this.kernel.profiler.shouldProfileUpdates()) {
        this.kernel.profiler.withActorPhase(buildActorProfileMeta(actor), "update", syncPluginObject);
      } else {
        syncPluginObject();
      }
    } catch (error) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: `Plugin syncObject failed: ${formatLoadError(error)}`,
        updatedAtIso: new Date().toISOString()
      });
    }
  }

  private sampleCurveWorldPoint(
    actorId: string,
    t: number
  ): {
    position: [number, number, number];
    tangent: [number, number, number];
  } | null {
    const state = this.kernel.store.getState().state;
    const actor = state.actors[actorId];
    if (!actor || actor.actorType !== "curve") {
      return null;
    }
    const sampled = sampleCurvePositionAndTangent(curveDataWithOverrides(actor), t);
    const worldMatrix = this.resolveActorWorldMatrix(actor.id, state.actors);
    const worldPosition = new THREE.Vector3(...sampled.position).applyMatrix4(worldMatrix);
    const normalMatrix = new THREE.Matrix3().setFromMatrix4(worldMatrix);
    const worldTangent = new THREE.Vector3(...sampled.tangent).applyMatrix3(normalMatrix).normalize();
    return {
      position: [worldPosition.x, worldPosition.y, worldPosition.z],
      tangent: [worldTangent.x, worldTangent.y, worldTangent.z]
    };
  }

  private actorLocalMatrix(transform: ActorNode["transform"]): any {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(...transform.position);
    const rotation = new THREE.Euler(...transform.rotation, "XYZ");
    const quaternion = new THREE.Quaternion().setFromEuler(rotation);
    const scale = new THREE.Vector3(...transform.scale);
    matrix.compose(position, quaternion, scale);
    return matrix;
  }

  private getGaussianSpriteTexture(): any {
    if (this.gaussianSpriteTexture) {
      return this.gaussianSpriteTexture;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.8)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.clearRect(0, 0, 64, 64);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    this.gaussianSpriteTexture = texture;
    return texture;
  }

  private buildGaussianFallbackMesh(
    geometry: any,
    _pointSize: number,
    splatSize: number,
    opacity: number,
    filterSpec: GaussianFallbackFilterSpec | null
  ): any {
    const position = geometry.getAttribute("position");
    if (!position) {
      return new THREE.Group();
    }
    const color = getAttribute(geometry, ["color", "rgba", "rgb", "diffuse", "albedo"]);
    const red = getAttribute(geometry, ["red"]);
    const green = getAttribute(geometry, ["green"]);
    const blue = getAttribute(geometry, ["blue"]);
    const fdc0 = getAttribute(geometry, ["f_dc_0", "dc_0", "f_dc0"]);
    const fdc1 = getAttribute(geometry, ["f_dc_1", "dc_1", "f_dc1"]);
    const fdc2 = getAttribute(geometry, ["f_dc_2", "dc_2", "f_dc2"]);
    const scale0 = getAttribute(geometry, ["scale_0", "sx"]);
    const scale1 = getAttribute(geometry, ["scale_1", "sy"]);
    const scale2 = getAttribute(geometry, ["scale_2", "sz"]);
    const rot0 = getAttribute(geometry, ["rot_0", "r_0"]);
    const rot1 = getAttribute(geometry, ["rot_1", "r_1"]);
    const rot2 = getAttribute(geometry, ["rot_2", "r_2"]);
    const rot3 = getAttribute(geometry, ["rot_3", "r_3"]);
    const scale0Range = readAttributeRange(scale0);
    const scale1Range = readAttributeRange(scale1);
    const scale2Range = readAttributeRange(scale2);
    const useLogScale =
      Boolean(scale0 && scale1 && scale2) &&
      (scale0Range.min < 0 || scale1Range.min < 0 || scale2Range.min < 0);
    const colorDenominator = detectColorDenominator(color);
    const colorSpread = estimateAttributeSpread(color);
    const colorMean = estimateAttributeMean(color);
    const hasShColor = Boolean(fdc0 && fdc1 && fdc2);
    const packedColorLooksFlat = Boolean(color) && colorSpread < 0.01;
    const packedColorLooksWhite = Boolean(color) && colorDenominator === 1 && colorMean > 0.97;
    const preferShColor = hasShColor && (!color || packedColorLooksFlat || packedColorLooksWhite);
    const usePackedColor = Boolean(color) && !preferShColor;

    const maxInstances = MAX_GAUSSIAN_BILLBOARD_INSTANCES;
    const stride = Math.max(1, Math.ceil(position.count / maxInstances));
    const instanceCount = Math.ceil(position.count / stride);
    const centers = new Float32Array(instanceCount * 3);
    const scales = new Float32Array(instanceCount * 2);
    const rotations = new Float32Array(instanceCount * 4);
    const colors = new Float32Array(instanceCount * 3);
    const baseGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.getGaussianSpriteTexture(),
      alphaTest: 0.01,
      vertexColors: true,
      transparent: true,
      opacity: Math.min(1, Math.max(0, opacity)),
      depthTest: true,
      depthWrite: false
    });
    const mesh = new THREE.InstancedMesh(baseGeometry, material, instanceCount);
    mesh.frustumCulled = false;
    const translation = new THREE.Vector3();
    const tempColor = new THREE.Color(0xffffff);
    const SH_C0 = 0.28209479177387814;

    let cursor = 0;
    let colorAccumR = 0;
    let colorAccumG = 0;
    let colorAccumB = 0;
    let colorAccumCount = 0;
    const samplePosition = new THREE.Vector3();
    const localSampleInRegion = new THREE.Vector3();
    for (let index = 0; index < position.count; index += stride) {
      translation.set(position.getX(index), position.getY(index), position.getZ(index));
      if (filterSpec) {
        samplePosition.copy(translation);
        const shouldRender = this.isGaussianPointVisible(samplePosition, filterSpec, localSampleInRegion);
        if (!shouldRender) {
          continue;
        }
      }

      let scaleXFactor = 1;
      let scaleYFactor = 1;
      const baseScale = Math.max(0.2, splatSize);
      if (scale0 && scale1 && scale2) {
        const rawScaleX = scale0.getX(index);
        const rawScaleY = scale1.getX(index);
        const rawScaleZ = scale2.getX(index);
        const sx = useLogScale ? Math.exp(rawScaleX) : Math.max(0.0001, rawScaleX);
        const sy = useLogScale ? Math.exp(rawScaleY) : Math.max(0.0001, rawScaleY);
        const sz = useLogScale ? Math.exp(rawScaleZ) : Math.max(0.0001, rawScaleZ);
        scaleXFactor = Math.max(0.05, sx);
        scaleYFactor = Math.max(0.05, sy);
        // Prevent extreme axis collapse when one covariance axis is near zero.
        if (scaleXFactor < 0.06 && scaleYFactor > 0.5) {
          scaleXFactor = Math.max(scaleXFactor, sz * 0.25);
        }
        if (scaleYFactor < 0.06 && scaleXFactor > 0.5) {
          scaleYFactor = Math.max(scaleYFactor, sz * 0.25);
        }
      }
      const instanceScaleX = Math.max(0.01, baseScale * scaleXFactor);
      const instanceScaleY = Math.max(0.01, baseScale * scaleYFactor);
      const i3 = cursor * 3;
      centers[i3] = translation.x;
      centers[i3 + 1] = translation.y;
      centers[i3 + 2] = translation.z;
      const i2 = cursor * 2;
      scales[i2] = instanceScaleX;
      scales[i2 + 1] = instanceScaleY;
      const i4 = cursor * 4;
      if (rot0 && rot1 && rot2 && rot3) {
        // Common gaussian splat export layout: rot_0..3 = w,x,y,z
        rotations[i4] = rot1.getX(index);
        rotations[i4 + 1] = rot2.getX(index);
        rotations[i4 + 2] = rot3.getX(index);
        rotations[i4 + 3] = rot0.getX(index);
      } else {
        rotations[i4] = 0;
        rotations[i4 + 1] = 0;
        rotations[i4 + 2] = 0;
        rotations[i4 + 3] = 1;
      }
      if (usePackedColor) {
        const rawR = color.getX(index);
        const rawG = color.getY(index);
        const rawB = color.getZ(index);
        if (colorDenominator > 1) {
          tempColor.setRGB(clamp01(rawR / colorDenominator), clamp01(rawG / colorDenominator), clamp01(rawB / colorDenominator));
        } else {
          tempColor.setRGB(clamp01(rawR), clamp01(rawG), clamp01(rawB));
        }
      } else if (red && green && blue) {
        tempColor.setRGB(clamp01(red.getX(index) / 255), clamp01(green.getX(index) / 255), clamp01(blue.getX(index) / 255));
      } else if (hasShColor) {
        tempColor.setRGB(
          clamp01(0.5 + SH_C0 * fdc0.getX(index)),
          clamp01(0.5 + SH_C0 * fdc1.getX(index)),
          clamp01(0.5 + SH_C0 * fdc2.getX(index))
        );
      } else {
        tempColor.setRGB(1, 1, 1);
      }

      colorAccumR += tempColor.r;
      colorAccumG += tempColor.g;
      colorAccumB += tempColor.b;
      colorAccumCount += 1;
      colors[i3] = tempColor.r;
      colors[i3 + 1] = tempColor.g;
      colors[i3 + 2] = tempColor.b;
      cursor += 1;
    }
    const usedCenters = centers.slice(0, cursor * 3);
    const usedScales = scales.slice(0, cursor * 2);
    const usedRotations = rotations.slice(0, cursor * 4);
    const usedColors = colors.slice(0, cursor * 3);
    const trianglesPerInstance = Math.max(0, Number(baseGeometry.index?.count ?? 0) / 3);
    const chunks = this.buildGaussianSortChunks(usedCenters, usedScales);

    mesh.count = cursor;
    mesh.userData.visibleCount = cursor;
    mesh.userData.triangleCount = Math.max(0, cursor * trianglesPerInstance);
    mesh.userData.sortableBatch = {
      actorId: "",
      mesh,
      count: cursor,
      trianglesPerInstance,
      centersBase: usedCenters,
      scalesBase: usedScales,
      rotationsBase: usedRotations,
      colorsBase: usedColors,
      chunks,
      candidateIndices: [],
      indices: Array.from({ length: cursor }, (_, i) => i),
      depths: new Float32Array(cursor)
    } as GaussianSortableBatch;
    mesh.userData.colorDebug = {
      source: usePackedColor ? "color/rgb/diffuse" : hasShColor ? "f_dc_0..2" : red && green && blue ? "red/green/blue" : "white",
      colorSpread,
      colorDenominator,
      averageColor:
        colorAccumCount > 0
          ? [colorAccumR / colorAccumCount, colorAccumG / colorAccumCount, colorAccumB / colorAccumCount]
          : [0, 0, 0]
    };
    return mesh;
  }

  private buildGaussianSortChunks(centersBase: Float32Array, scalesBase: Float32Array): GaussianSortChunk[] {
    const count = Math.floor(centersBase.length / 3);
    if (count <= 0) {
      return [];
    }
    if (count <= 2048) {
      const indices = new Uint32Array(count);
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < count; i += 1) {
        indices[i] = i;
        const i3 = i * 3;
        const x = centersBase[i3] ?? 0;
        const y = centersBase[i3 + 1] ?? 0;
        const z = centersBase[i3 + 2] ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      let radius = 0.001;
      for (let i = 0; i < count; i += 1) {
        const i3 = i * 3;
        const dx = (centersBase[i3] ?? 0) - cx;
        const dy = (centersBase[i3 + 1] ?? 0) - cy;
        const dz = (centersBase[i3 + 2] ?? 0) - cz;
        const i2 = i * 2;
        const extent = Math.max(scalesBase[i2] ?? 0, scalesBase[i2 + 1] ?? 0, 0);
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + extent);
      }
      return [{ indices, center: [cx, cy, cz], radius }];
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const x = centersBase[i3] ?? 0;
      const y = centersBase[i3 + 1] ?? 0;
      const z = centersBase[i3 + 2] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const extentX = Math.max(0.001, maxX - minX);
    const extentY = Math.max(0.001, maxY - minY);
    const extentZ = Math.max(0.001, maxZ - minZ);
    const targetChunkCount = Math.max(1, Math.ceil(count / 2048));
    const grid = Math.max(1, Math.round(Math.cbrt(targetChunkCount)));
    const cellX = extentX / grid;
    const cellY = extentY / grid;
    const cellZ = extentZ / grid;
    const bucketMap = new Map<string, number[]>();

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const x = centersBase[i3] ?? 0;
      const y = centersBase[i3 + 1] ?? 0;
      const z = centersBase[i3 + 2] ?? 0;
      const gx = Math.max(0, Math.min(grid - 1, Math.floor((x - minX) / cellX)));
      const gy = Math.max(0, Math.min(grid - 1, Math.floor((y - minY) / cellY)));
      const gz = Math.max(0, Math.min(grid - 1, Math.floor((z - minZ) / cellZ)));
      const key = `${gx}|${gy}|${gz}`;
      const bucket = bucketMap.get(key);
      if (bucket) {
        bucket.push(i);
      } else {
        bucketMap.set(key, [i]);
      }
    }

    const chunks: GaussianSortChunk[] = [];
    for (const indices of bucketMap.values()) {
      if (indices.length <= 0) {
        continue;
      }
      let localMinX = Number.POSITIVE_INFINITY;
      let localMinY = Number.POSITIVE_INFINITY;
      let localMinZ = Number.POSITIVE_INFINITY;
      let localMaxX = Number.NEGATIVE_INFINITY;
      let localMaxY = Number.NEGATIVE_INFINITY;
      let localMaxZ = Number.NEGATIVE_INFINITY;
      for (const index of indices) {
        const i3 = index * 3;
        const x = centersBase[i3] ?? 0;
        const y = centersBase[i3 + 1] ?? 0;
        const z = centersBase[i3 + 2] ?? 0;
        if (x < localMinX) localMinX = x;
        if (y < localMinY) localMinY = y;
        if (z < localMinZ) localMinZ = z;
        if (x > localMaxX) localMaxX = x;
        if (y > localMaxY) localMaxY = y;
        if (z > localMaxZ) localMaxZ = z;
      }
      const cx = (localMinX + localMaxX) * 0.5;
      const cy = (localMinY + localMaxY) * 0.5;
      const cz = (localMinZ + localMaxZ) * 0.5;
      let radius = 0.001;
      for (const index of indices) {
        const i3 = index * 3;
        const dx = (centersBase[i3] ?? 0) - cx;
        const dy = (centersBase[i3 + 1] ?? 0) - cy;
        const dz = (centersBase[i3 + 2] ?? 0) - cz;
        const i2 = index * 2;
        const extent = Math.max(scalesBase[i2] ?? 0, scalesBase[i2 + 1] ?? 0, 0);
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + extent);
      }
      chunks.push({
        indices: Uint32Array.from(indices),
        center: [cx, cy, cz],
        radius
      });
    }
    return chunks;
  }

  private applySceneBackgroundColor(): void {
    const state = this.kernel.store.getState().state;
    const sceneColor = normalizeBackgroundColor(state.scene.backgroundColor);
    if (this.currentEnvironmentAssetId) {
      return;
    }
    this.scene.background = new THREE.Color(sceneColor);
  }
}

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, ActorRuntimeStatus, AppState } from "@/core/types";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { getEffectiveCurveHandles } from "@/features/curves/handles";
import { curveDataWithOverrides, getCurveSamplesPerSegmentFromActor } from "@/features/curves/model";
import { estimateCurveLength, sampleCurvePositionAndTangent } from "@/features/curves/sampler";
import { tryParseSplatBinary } from "@/features/splats/splatBinaryFormat";
import { getGaussianFilterMode, getGaussianFilterRegionActorIds } from "@/render/gaussianFilter";
import type { SplatQueryArgs, VisibleSplatSample } from "@/render/splatQueryRegistry";

const GAUSSIAN_RENDER_ROOT_NAME = "gaussian-splat-render-root";
const GAUSSIAN_RENDER_MESH_NAME = "gaussian-splat-render";
const MESH_RENDER_ROOT_NAME = "mesh-render-root";
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
  private readonly actorObjects = new Map<string, any>();
  private readonly gaussianAssetByActorId = new Map<string, string>();
  private readonly gaussianReloadTokenByActorId = new Map<string, number>();
  private readonly meshAssetByActorId = new Map<string, string>();
  private readonly meshReloadTokenByActorId = new Map<string, number>();
  private readonly gaussianBoundsHelpers = new Map<string, any>();
  private readonly meshLoadTokenByActorId = new Map<string, number>();
  private readonly primitiveSignatureByActorId = new Map<string, string>();
  private readonly gaussianGeometryByActorId = new Map<string, any>();
  private readonly gaussianVisualSignatureByActorId = new Map<string, string>();
  private readonly gaussianVisibleCountByActorId = new Map<string, number>();
  private readonly gaussianTriangleCountByActorId = new Map<string, number>();
  private readonly gaussianSortableBatchesByActorId = new Map<string, GaussianSortableBatch>();
  private readonly curveSignatureByActorId = new Map<string, string>();
  private readonly lastKnownActorById = new Map<string, ActorNode>();
  private readonly plyLoader = new PLYLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly fbxLoader = new FBXLoader();
  private readonly colladaLoader = new ColladaLoader();
  private readonly objLoader = new OBJLoader();
  private readonly rgbeLoader = new RGBELoader();
  private readonly ktx2Loader = new KTX2Loader();
  private gaussianSpriteTexture: any | null = null;
  private currentEnvironmentAssetId: string | null = null;
  private currentEnvironmentReloadToken = 0;
  private gaussianSortFrameCounter = 0;
  private hasGaussianCameraState = false;
  private readonly gaussianLastCameraPosition = new THREE.Vector3();
  private readonly gaussianLastCameraQuaternion = new THREE.Quaternion();
  private gaussianSortDirty = true;
  private previousSimTimeSeconds = 0;

  public constructor(private readonly kernel: AppKernel) {
    const initialBackground = normalizeBackgroundColor(this.kernel.store.getState().state.scene.backgroundColor);
    this.scene.background = new THREE.Color(initialBackground);
    const grid = new THREE.GridHelper(20, 20, 0x2f8f9d, 0x1f2430);
    (grid.material as any).transparent = true;
    (grid.material as any).opacity = 0.35;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(2.5));
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(8, 12, 6);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.ktx2Loader.setTranscoderPath("/basis/");
  }

  public async syncFromState(): Promise<void> {
    const state = this.kernel.store.getState().state;
    const actorIds = new Set(Object.keys(state.actors));
    const simTimeSeconds = Number.isFinite(state.time.elapsedSimSeconds) ? state.time.elapsedSimSeconds : 0;
    const dtSeconds = Math.max(0, simTimeSeconds - this.previousSimTimeSeconds);
    this.previousSimTimeSeconds = simTimeSeconds;

    for (const existing of [...this.actorObjects.keys()]) {
      if (!actorIds.has(existing)) {
        const object = this.actorObjects.get(existing);
        const removedActor = this.lastKnownActorById.get(existing) ?? null;
        this.disposePluginSceneObject(removedActor, object);
        if (object) {
          object.parent?.remove(object);
        }
        this.actorObjects.delete(existing);
        this.gaussianAssetByActorId.delete(existing);
        this.gaussianReloadTokenByActorId.delete(existing);
        this.meshAssetByActorId.delete(existing);
        this.meshReloadTokenByActorId.delete(existing);
        this.meshLoadTokenByActorId.delete(existing);
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
        this.kernel.store.getState().actions.setActorStatus(existing, null);
        this.primitiveSignatureByActorId.delete(existing);
        this.lastKnownActorById.delete(existing);
      }
    }

    for (const actor of Object.values(state.actors)) {
      this.lastKnownActorById.set(actor.id, structuredClone(actor));
      await this.ensureActorObject(actor);
      this.syncActorParentAttachment(actor.id, actor.parentActorId);
      if (actor.actorType === "gaussian-splat") {
        await this.syncGaussianSplatAsset(actor);
      }
      if (actor.actorType === "mesh") {
        await this.syncMeshAsset(actor);
      }
      if (actor.actorType === "primitive") {
        this.syncPrimitiveActor(actor);
      }
      if (actor.actorType === "curve") {
        this.syncCurveActor(actor);
      }
      this.applyActorTransform(actor);
    }
    for (const actor of Object.values(state.actors)) {
      this.syncActorParentAttachment(actor.id, actor.parentActorId);
    }
    for (const actor of Object.values(state.actors)) {
      this.syncPluginSceneActor(actor, state, simTimeSeconds, dtSeconds);
    }

    this.applySceneBackgroundColor();
    await this.updateEnvironmentTexture();
  }

  public getActorObject(actorId: string): any | null {
    return this.actorObjects.get(actorId) ?? null;
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

  public queryVisibleSplats(args?: SplatQueryArgs): VisibleSplatSample[] {
    const state = this.kernel.store.getState().state;
    const maxResults = Math.max(1, Math.min(50000, Math.floor(args?.maxResults ?? 5000)));
    const actorIdFilter = args?.actorIds ? new Set(args.actorIds) : null;
    const bounds = args?.bounds
      ? new THREE.Box3(
          new THREE.Vector3(args.bounds.min[0], args.bounds.min[1], args.bounds.min[2]),
          new THREE.Vector3(args.bounds.max[0], args.bounds.max[1], args.bounds.max[2])
        )
      : null;
    const results: VisibleSplatSample[] = [];
    const sampleLocal = new THREE.Vector3();
    const sampleWorld = new THREE.Vector3();
    const sampleInRegion = new THREE.Vector3();

    for (const actor of Object.values(state.actors)) {
      if (actor.actorType !== "gaussian-splat" || !actor.enabled) {
        continue;
      }
      if (actorIdFilter && !actorIdFilter.has(actor.id)) {
        continue;
      }
      const geometry = this.gaussianGeometryByActorId.get(actor.id);
      const actorObject = this.actorObjects.get(actor.id);
      if (!geometry || !(actorObject instanceof THREE.Group) || actorObject.visible === false) {
        continue;
      }
      const correctedRoot = actorObject.getObjectByName(GAUSSIAN_RENDER_ROOT_NAME);
      if (!(correctedRoot instanceof THREE.Group)) {
        continue;
      }
      const position = geometry.getAttribute("position");
      if (!position || typeof position.count !== "number") {
        continue;
      }
      const filterSpec = this.buildGaussianFilterSpec(actor);
      const opacity = Number(actor.params.opacity ?? 1);
      for (let index = 0; index < position.count; index += 1) {
        sampleLocal.set(position.getX(index), position.getY(index), position.getZ(index));
        if (filterSpec && !this.isGaussianPointVisible(sampleLocal, filterSpec, sampleInRegion)) {
          continue;
        }
        sampleWorld.copy(sampleLocal);
        correctedRoot.localToWorld(sampleWorld);
        if (bounds && !bounds.containsPoint(sampleWorld)) {
          continue;
        }
        results.push({
          actorId: actor.id,
          splatIndex: index,
          position: [sampleWorld.x, sampleWorld.y, sampleWorld.z],
          opacity
        });
        if (results.length >= maxResults) {
          return results;
        }
      }
    }
    return results;
  }

  private async ensureActorObject(actor: ActorNode): Promise<void> {
    if (!this.actorObjects.has(actor.id)) {
      const object = await this.createObjectForActor(actor);
      this.actorObjects.set(actor.id, object);
    }
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

  private async createObjectForActor(actor: ActorNode): Promise<any> {
    const pluginCreated = this.createPluginSceneObject(actor);
    if (pluginCreated) {
      return pluginCreated;
    }
    if (actor.actorType === "gaussian-splat") {
      const container = new THREE.Group();
      container.name = "gaussian-splat-container";

      const correctedRoot = new THREE.Group();
      correctedRoot.name = GAUSSIAN_RENDER_ROOT_NAME;
      correctedRoot.rotation.copy(SPLAT_COORDINATE_CORRECTION_EULER);

      container.add(correctedRoot);
      return container;
    }

    if (actor.actorType === "mesh") {
      const container = new THREE.Group();
      container.name = "mesh-container";
      const renderRoot = new THREE.Group();
      renderRoot.name = MESH_RENDER_ROOT_NAME;
      container.add(renderRoot);
      return container;
    }

    if (actor.actorType === "environment") {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.15),
        new THREE.MeshStandardMaterial({ color: 0x33ffaa, emissive: 0x112222 })
      );
      return marker;
    }

    if (actor.actorType === "primitive") {
      return this.createPrimitiveMesh(actor);
    }

    if (actor.actorType === "curve") {
      const group = new THREE.Group();
      group.name = "curve-container";
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
      cubeSize: Number.isFinite(cubeSizeRaw) ? Math.max(0.05, cubeSizeRaw) : 1,
      sphereRadius: Number.isFinite(sphereRadiusRaw) ? Math.max(0.05, sphereRadiusRaw) : 0.5,
      cylinderRadius: Number.isFinite(cylinderRadiusRaw) ? Math.max(0.05, cylinderRadiusRaw) : 0.5,
      cylinderHeight: Number.isFinite(cylinderHeightRaw) ? Math.max(0.05, cylinderHeightRaw) : 1,
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
        return new THREE.SphereGeometry(Math.max(0.05, sphereRadius), safeRoundSegments, safeRoundSegments);
      case "cylinder":
        return new THREE.CylinderGeometry(
          Math.max(0.05, cylinderRadius),
          Math.max(0.05, cylinderRadius),
          Math.max(0.05, cylinderHeight),
          safeRoundSegments
        );
      case "cube":
      default:
        return new THREE.BoxGeometry(
          Math.max(0.05, cubeSize),
          Math.max(0.05, cubeSize),
          Math.max(0.05, cubeSize),
          safeSegments,
          safeSegments,
          safeSegments
        );
    }
  }

  private createPrimitiveMesh(actor: ActorNode): any {
    const dimensions = this.getPrimitiveDimensions(actor);
    const color = typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff";
    const wireframe = Boolean(actor.params.wireframe);
    const mesh = new THREE.Mesh(
      this.createPrimitiveGeometry(
        dimensions.shape,
        dimensions.cubeSize,
        dimensions.sphereRadius,
        dimensions.cylinderRadius,
        dimensions.cylinderHeight,
        dimensions.segments
      ),
      new THREE.MeshStandardMaterial({
        color,
        wireframe,
        metalness: 0.08,
        roughness: 0.72
      })
    );
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  private syncPrimitiveActor(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const dimensions = this.getPrimitiveDimensions(actor);
    const color = typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff";
    const wireframe = Boolean(actor.params.wireframe);
    const signature = JSON.stringify({
      ...dimensions,
      color,
      wireframe
    });
    const previous = this.primitiveSignatureByActorId.get(actor.id);
    if (signature === previous) {
      return;
    }
    this.primitiveSignatureByActorId.set(actor.id, signature);

    // Avoid disposing geometry here: WebGPU renderer can still reference buffers during async pipeline updates.
    object.geometry = this.createPrimitiveGeometry(
      dimensions.shape,
      dimensions.cubeSize,
      dimensions.sphereRadius,
      dimensions.cylinderRadius,
      dimensions.cylinderHeight,
      dimensions.segments
    );
    const material = object.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.set(color);
      material.wireframe = wireframe;
      material.needsUpdate = true;
    }
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
    const activePoints = curveData.points.filter((point) => point.enabled !== false);
    const samplesPerSegment = getCurveSamplesPerSegmentFromActor(actor);
    const pointCount = activePoints.length;
    const skippedPointCount = Math.max(0, curveData.points.length - activePoints.length);
    const segmentCount = pointCount < 2 ? 0 : (curveData.closed ? pointCount : pointCount - 1);
    const signature = JSON.stringify({
      curveData,
      samplesPerSegment
    });
    if (signature === this.curveSignatureByActorId.get(actor.id)) {
      return;
    }
    this.curveSignatureByActorId.set(actor.id, signature);

    const sampled: any[] = [];
    if (segmentCount > 0) {
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        const current = activePoints[segmentIndex];
        const next = activePoints[(segmentIndex + 1) % pointCount];
        if (!current || !next) {
          continue;
        }
        const currentHandles = getEffectiveCurveHandles(current);
        const nextHandles = getEffectiveCurveHandles(next);
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
        closed: curveData.closed,
        samplesPerSegment,
        length,
        boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
        boundsMax: [bounds.max.x, bounds.max.y, bounds.max.z]
      },
      updatedAtIso: new Date().toISOString()
    });
  }

  private applyActorTransform(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!object) {
      return;
    }
    const selection = this.kernel.store.getState().state.selection;
    const isSelected = selection.some((entry) => entry.kind === "actor" && entry.id === actor.id);
    const visibilityMode = actor.visibilityMode ?? "visible";
    const visibleByMode = visibilityMode === "visible" || (visibilityMode === "selected" && isSelected);
    object.visible = actor.enabled && visibleByMode;
    object.position.set(...actor.transform.position);
    object.rotation.set(...actor.transform.rotation);
    object.scale.set(...actor.transform.scale);
    if (actor.actorType === "gaussian-splat" && object instanceof THREE.Group) {
      const correctedRoot = object.getObjectByName(GAUSSIAN_RENDER_ROOT_NAME);
      if (correctedRoot instanceof THREE.Group) {
        const scaleFactor = Number(actor.params.scaleFactor ?? 1);
        const safe = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        correctedRoot.scale.setScalar(safe);
      }
    }
    if (actor.actorType === "mesh" && object instanceof THREE.Group) {
      const renderRoot = object.getObjectByName(MESH_RENDER_ROOT_NAME);
      if (renderRoot instanceof THREE.Group) {
        const scaleFactor = Number(actor.params.scaleFactor ?? 1);
        const safe = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        renderRoot.scale.setScalar(safe);
      }
    }
  }

  private async syncGaussianSplatAsset(actor: ActorNode): Promise<void> {
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
        error: "Asset reference not found in session state.",
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
        sessionName: state.activeSessionName,
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
      return;
    }
    this.meshAssetByActorId.set(actor.id, assetId);
    this.meshReloadTokenByActorId.set(actor.id, reloadToken);

    renderRoot.clear();

    if (!assetId) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setStatus("Mesh asset reference not found in session state.");
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {},
        error: "Asset reference not found in session state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }

    const extension = asset.relativePath.split(".").pop()?.toLowerCase() ?? "";
    const url = await this.kernel.storage.resolveAssetPath({
      sessionName: state.activeSessionName,
      relativePath: asset.relativePath
    });
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        format: extension || "unknown",
        assetFileName: asset.sourceFileName,
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });

    const loadToken = (this.meshLoadTokenByActorId.get(actor.id) ?? 0) + 1;
    this.meshLoadTokenByActorId.set(actor.id, loadToken);

    const attachLoaded = (loadedObject: any) => {
      if (this.meshLoadTokenByActorId.get(actor.id) !== loadToken) {
        return;
      }
      renderRoot.clear();
      renderRoot.add(loadedObject);
      loadedObject.traverse((node: any) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
          if (!Array.isArray(node.material) && node.material) {
            node.material.needsUpdate = true;
          }
        }
      });
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
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          format: extension || "unknown",
          assetFileName: asset.sourceFileName,
          loadState: "loaded",
          meshCount,
          triangleCount,
          boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
          boundsMax: [bounds.max.x, bounds.max.y, bounds.max.z],
          size: [size.x, size.y, size.z]
        },
        updatedAtIso: new Date().toISOString()
      });
      this.kernel.store
        .getState()
        .actions.setStatus(
          `Mesh loaded: ${asset.sourceFileName} (${extension || "unknown"}) | size (m): ${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}`
        );
    };

    const onError = (error: unknown) => {
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
            attachLoaded(result.scene);
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
            attachLoaded(fbx);
          },
          undefined,
          onError
        );
        return;
      }
      if (extension === "dae") {
        this.colladaLoader.load(
          url,
          (collada: any) => {
            attachLoaded(collada.scene);
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
      const safeCubeSize = Number.isFinite(cubeSizeRaw) && cubeSizeRaw > 0 ? cubeSizeRaw : 1;
      const safeSphereRadius = Number.isFinite(sphereRadiusRaw) && sphereRadiusRaw > 0 ? sphereRadiusRaw : 0.5;
      const safeCylinderRadius = Number.isFinite(cylinderRadiusRaw) && cylinderRadiusRaw > 0 ? cylinderRadiusRaw : 0.5;
      const safeCylinderHeight = Number.isFinite(cylinderHeightRaw) && cylinderHeightRaw > 0 ? cylinderHeightRaw : 1;
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

  private createPluginSceneObject(actor: ActorNode): any | null {
    if (actor.actorType !== "plugin") {
      return null;
    }
    const descriptor = this.resolveActorDescriptor(actor);
    if (!descriptor?.sceneHooks?.createObject) {
      return null;
    }
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

  private disposePluginSceneObject(actor: ActorNode | null, object: unknown): void {
    if (!actor || !object) {
      return;
    }
    const descriptor = this.resolveActorDescriptor(actor);
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
    if (!descriptor?.sceneHooks?.syncObject) {
      return;
    }
    const object = this.actorObjects.get(actor.id);
    if (!object) {
      return;
    }
    try {
      descriptor.sceneHooks.syncObject({
        actor,
        state,
        object,
        simTimeSeconds,
        dtSeconds,
        getActorById: (actorId) => this.kernel.store.getState().state.actors[actorId] ?? null,
        getActorObject: (actorId) => this.actorObjects.get(actorId) ?? null,
        sampleCurveWorldPoint: (actorId, t) => this.sampleCurveWorldPoint(actorId, t),
        setActorStatus: (status: ActorRuntimeStatus | null) => {
          this.kernel.store.getState().actions.setActorStatus(actor.id, status);
        }
      });
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

  private async updateEnvironmentTexture(): Promise<void> {
    const state = this.kernel.store.getState().state;
    const environmentActor = Object.values(state.actors).find((actor) => actor.actorType === "environment");
    if (!environmentActor) {
      if (this.currentEnvironmentAssetId) {
        this.scene.environment = null;
        this.applySceneBackgroundColor();
        this.currentEnvironmentAssetId = null;
      }
      return;
    }

    const assetId = typeof environmentActor.params.assetId === "string" ? environmentActor.params.assetId : null;
    const reloadToken =
      typeof environmentActor.params.assetIdReloadToken === "number" ? environmentActor.params.assetIdReloadToken : 0;
    if (!assetId) {
      this.scene.environment = null;
      this.currentEnvironmentAssetId = null;
      this.currentEnvironmentReloadToken = 0;
      this.applySceneBackgroundColor();
      this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
        values: {
          loadState: "idle"
        },
        updatedAtIso: new Date().toISOString()
      });
      return;
    }
    if (assetId === this.currentEnvironmentAssetId && reloadToken === this.currentEnvironmentReloadToken) {
      return;
    }

    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
        values: {},
        error: "Asset reference not found in session state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }
    const url = await this.kernel.storage.resolveAssetPath({
      sessionName: state.activeSessionName,
      relativePath: asset.relativePath
    });

    const extension = asset.relativePath.split(".").pop()?.toLowerCase();
    this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
      values: {
        format: extension ?? "hdr",
        assetFileName: asset.sourceFileName,
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });
    if (extension === "ktx2") {
      this.ktx2Loader.load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.scene.environment = texture;
          this.scene.background = texture;
          this.currentEnvironmentAssetId = asset.id;
          this.currentEnvironmentReloadToken = reloadToken;
          this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
            values: {
              format: "ktx2",
              assetFileName: asset.sourceFileName,
              loadState: "loaded"
            },
            updatedAtIso: new Date().toISOString()
          });
        },
        undefined,
        () => {
          this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
            values: {
              format: "ktx2",
              assetFileName: asset.sourceFileName,
              loadState: "failed"
            },
            error: "KTX2 environment load failed. Ensure basis transcoders are available.",
            updatedAtIso: new Date().toISOString()
          });
          this.kernel.store.getState().actions.setStatus(
            "KTX2 environment load failed. Ensure basis transcoder files are available in /public/basis."
          );
        }
      );
      return;
    }

    this.rgbeLoader.load(
      url,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.scene.environment = texture;
        this.scene.background = texture;
        this.currentEnvironmentAssetId = asset.id;
        this.currentEnvironmentReloadToken = reloadToken;
        this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
          values: {
            format: extension ?? "hdr",
            assetFileName: asset.sourceFileName,
            loadState: "loaded"
          },
          updatedAtIso: new Date().toISOString()
        });
      },
      undefined,
      () => {
        this.kernel.store.getState().actions.setActorStatus(environmentActor.id, {
          values: {
            format: extension ?? "hdr",
            assetFileName: asset.sourceFileName,
            loadState: "failed"
          },
          error: "Environment texture load failed.",
          updatedAtIso: new Date().toISOString()
        });
        this.kernel.store.getState().actions.setStatus("Environment texture load failed.");
      }
    );
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

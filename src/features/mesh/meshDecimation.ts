import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { MeshoptSimplifier, type Flags as MeshoptFlag } from "meshoptimizer";

export type MeshSourceFormat = "glb" | "gltf" | "fbx" | "obj" | "dae";

export type DecimationStage = "parse" | "decimate" | "export";

export interface DecimationProgress {
  stage: DecimationStage;
  completed: number;
  total: number;
  message: string;
}

export interface DecimationCancelToken {
  canceled: boolean;
}

export interface DecimationRequest {
  ratios: number[];
  format: MeshSourceFormat;
  errorTarget?: number;
  preserveBorders?: boolean;
  onProgress?: (progress: DecimationProgress) => void;
  cancelToken?: DecimationCancelToken;
}

export interface DecimationResult {
  ratio: number;
  glbBytes: Uint8Array;
  triangleCount: number;
  originalTriangleCount: number;
}

export class DecimationError extends Error {}

export class DecimationCanceledError extends DecimationError {
  constructor() {
    super("Decimation canceled");
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function checkCanceled(token: DecimationCancelToken | undefined): void {
  if (token?.canceled) {
    throw new DecimationCanceledError();
  }
}

interface SimplifyTarget {
  geometry: THREE.BufferGeometry;
  parent: THREE.Object3D;
  meshIndex: number;
}

function collectSimplifiable(root: THREE.Object3D): { targets: SimplifyTarget[]; totalTris: number; hasSkinned: boolean; hasMorph: boolean } {
  const targets: SimplifyTarget[] = [];
  let totalTris = 0;
  let hasSkinned = false;
  let hasMorph = false;
  root.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      hasSkinned = true;
    }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) {
      hasMorph = true;
    }
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const indexCount = geometry.index?.count ?? 0;
    const positionCount = geometry.getAttribute("position")?.count ?? 0;
    totalTris += Math.floor((indexCount > 0 ? indexCount : positionCount) / 3);
    targets.push({ geometry, parent: mesh, meshIndex: targets.length });
  });
  return { targets, totalTris, hasSkinned, hasMorph };
}

function ensureUint32Indices(geometry: THREE.BufferGeometry): Uint32Array {
  if (geometry.index) {
    const arr = geometry.index.array as ArrayLike<number>;
    if (arr instanceof Uint32Array) return arr.slice();
    return Uint32Array.from(arr);
  }
  const positionCount = geometry.getAttribute("position")?.count ?? 0;
  const indices = new Uint32Array(positionCount);
  for (let i = 0; i < positionCount; i++) indices[i] = i;
  return indices;
}

function applySimplification(geometry: THREE.BufferGeometry, ratio: number, errorTarget: number, preserveBorders: boolean): number {
  const positionAttr = geometry.getAttribute("position");
  if (!positionAttr) return 0;
  const positions = positionAttr.array instanceof Float32Array
    ? (positionAttr.array as Float32Array)
    : Float32Array.from(positionAttr.array as ArrayLike<number>);
  const indices = ensureUint32Indices(geometry);
  const targetIndexCount = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const flags: MeshoptFlag[] = [];
  if (preserveBorders) flags.push("LockBorder");
  const [simplified] = MeshoptSimplifier.simplify(
    indices,
    positions,
    3,
    Math.min(targetIndexCount, indices.length),
    errorTarget,
    flags
  );

  const newIndex = new THREE.BufferAttribute(simplified, 1);
  geometry.setIndex(newIndex);
  geometry.clearGroups();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return Math.floor(simplified.length / 3);
}

interface GltfParseResult {
  scene: THREE.Object3D;
  animations?: THREE.AnimationClip[];
}
type GltfLoaderLike = {
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: GltfParseResult) => void,
    onError?: (event: unknown) => void
  ): void;
};
type FbxLoaderLike = { parse(data: ArrayBuffer | string, path: string): THREE.Group };
type ObjLoaderLike = { parse(data: string): THREE.Group };
type DaeLoaderLike = { parse(text: string, path: string): { scene: THREE.Object3D; animations?: THREE.AnimationClip[] } | null };

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : bytes.slice().buffer;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

async function parseGlb(bytes: Uint8Array): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const loader = new GLTFLoader() as unknown as GltfLoaderLike;
  const buf = bytesToArrayBuffer(bytes);
  return new Promise((resolve, reject) => {
    loader.parse(
      buf,
      "",
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      (event) => {
        const message = event instanceof ErrorEvent ? event.message : event instanceof Error ? event.message : String(event);
        reject(new Error(`GLTF parse failed: ${message}`));
      }
    );
  });
}

async function parseGltfText(bytes: Uint8Array): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const loader = new GLTFLoader() as unknown as GltfLoaderLike;
  const text = bytesToText(bytes);
  return new Promise((resolve, reject) => {
    loader.parse(
      text,
      "",
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      (event) => {
        const message = event instanceof ErrorEvent ? event.message : event instanceof Error ? event.message : String(event);
        reject(new Error(`GLTF parse failed: ${message}`));
      }
    );
  });
}

function parseFbx(bytes: Uint8Array): { scene: THREE.Object3D; animations: THREE.AnimationClip[] } {
  const loader = new FBXLoader() as unknown as FbxLoaderLike;
  const buf = bytesToArrayBuffer(bytes);
  const group = loader.parse(buf, "");
  const animations = (group as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [];
  return { scene: group, animations };
}

function parseObj(bytes: Uint8Array): { scene: THREE.Object3D; animations: THREE.AnimationClip[] } {
  const loader = new OBJLoader() as unknown as ObjLoaderLike;
  const group = loader.parse(bytesToText(bytes));
  return { scene: group, animations: [] };
}

function parseDae(bytes: Uint8Array): { scene: THREE.Object3D; animations: THREE.AnimationClip[] } {
  const loader = new ColladaLoader() as unknown as DaeLoaderLike;
  const result = loader.parse(bytesToText(bytes), "");
  if (!result) {
    throw new DecimationError("Collada parse returned no scene.");
  }
  return { scene: result.scene, animations: result.animations ?? [] };
}

async function parseSourceMesh(bytes: Uint8Array, format: MeshSourceFormat): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  switch (format) {
    case "glb":
      return parseGlb(bytes);
    case "gltf":
      return parseGltfText(bytes);
    case "fbx":
      return parseFbx(bytes);
    case "obj":
      return parseObj(bytes);
    case "dae":
      return parseDae(bytes);
    default:
      throw new DecimationError(`Unsupported mesh format: ${String(format)}`);
  }
}

export function detectMeshFormat(fileName: string): MeshSourceFormat | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "glb" || ext === "gltf" || ext === "fbx" || ext === "obj" || ext === "dae") {
    return ext;
  }
  return null;
}

async function exportGlb(scene: THREE.Object3D, animations: THREE.AnimationClip[]): Promise<Uint8Array> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Uint8Array(result));
        } else {
          reject(new Error("GLTFExporter returned a non-binary result; expected GLB ArrayBuffer."));
        }
      },
      (error) => reject(error),
      { binary: true, animations }
    );
  });
}

function cloneSceneWithGeometryClones(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.geometry = (mesh.geometry as THREE.BufferGeometry).clone();
    }
  });
  return clone;
}

export async function decimateMeshGlb(sourceBytes: Uint8Array, request: DecimationRequest): Promise<DecimationResult[]> {
  await MeshoptSimplifier.ready;
  if (!MeshoptSimplifier.supported) {
    throw new DecimationError("Mesh simplifier wasm is not supported in this environment.");
  }
  if (!request.ratios.length) {
    throw new DecimationError("At least one decimation ratio is required.");
  }
  for (const r of request.ratios) {
    if (!(r > 0 && r < 1)) {
      throw new DecimationError(`Decimation ratio ${r} must be between 0 and 1 (exclusive).`);
    }
  }

  const { onProgress, cancelToken } = request;
  const ratios = request.ratios;
  const errorTarget = request.errorTarget ?? 0.01;
  const preserveBorders = request.preserveBorders !== false;

  // Parse stage: 1 unit. Decimate stage: ratios * meshes units. Export stage: ratios units.
  // We know the mesh count after parsing; emit a placeholder total during parse.
  onProgress?.({ stage: "parse", completed: 0, total: 1, message: "Parsing source mesh..." });
  await yieldToUi();
  checkCanceled(cancelToken);

  const { scene: parsedScene, animations } = await parseSourceMesh(sourceBytes, request.format);
  const survey = collectSimplifiable(parsedScene);
  if (survey.hasSkinned || survey.hasMorph) {
    throw new DecimationError(
      "Cannot decimate skinned or morph-target meshes. Bake animations to keyframes first."
    );
  }
  if (survey.totalTris === 0) {
    throw new DecimationError("Source mesh has no triangle geometry.");
  }

  const meshCount = survey.targets.length;
  const decimateUnits = ratios.length * meshCount;
  const exportUnits = ratios.length;
  const totalUnits = 1 + decimateUnits + exportUnits;
  let completed = 1;
  onProgress?.({ stage: "parse", completed, total: totalUnits, message: `Parsed ${meshCount} mesh${meshCount === 1 ? "" : "es"}, ${survey.totalTris.toLocaleString()} triangles` });
  await yieldToUi();
  checkCanceled(cancelToken);

  const results: DecimationResult[] = [];
  for (let ratioIdx = 0; ratioIdx < ratios.length; ratioIdx++) {
    const ratio = ratios[ratioIdx]!;
    const ratioPct = Math.round(ratio * 100);
    const sceneClone = cloneSceneWithGeometryClones(parsedScene);
    const cloneSurvey = collectSimplifiable(sceneClone);
    let triangleCount = 0;
    for (let meshIdx = 0; meshIdx < cloneSurvey.targets.length; meshIdx++) {
      checkCanceled(cancelToken);
      const target = cloneSurvey.targets[meshIdx]!;
      triangleCount += applySimplification(target.geometry, ratio, errorTarget, preserveBorders);
      completed += 1;
      onProgress?.({
        stage: "decimate",
        completed,
        total: totalUnits,
        message: `Decimating ${ratioPct}% — mesh ${meshIdx + 1}/${cloneSurvey.targets.length}`
      });
      await yieldToUi();
    }

    checkCanceled(cancelToken);
    onProgress?.({
      stage: "export",
      completed,
      total: totalUnits,
      message: `Exporting LOD ${ratioPct}% (${triangleCount.toLocaleString()} tris)`
    });
    await yieldToUi();
    const glbBytes = await exportGlb(sceneClone, animations);
    completed += 1;
    onProgress?.({
      stage: "export",
      completed,
      total: totalUnits,
      message: `Exported LOD ${ratioPct}% (${triangleCount.toLocaleString()} tris)`
    });
    await yieldToUi();

    results.push({
      ratio,
      glbBytes,
      triangleCount,
      originalTriangleCount: survey.totalTris
    });
  }
  return results;
}

export async function probeMeshGlbForDecimation(sourceBytes: Uint8Array, format: MeshSourceFormat): Promise<{ triangleCount: number; canDecimate: boolean; reason?: string }> {
  try {
    const { scene } = await parseSourceMesh(sourceBytes, format);
    const survey = collectSimplifiable(scene);
    if (survey.hasSkinned) return { triangleCount: survey.totalTris, canDecimate: false, reason: "Skinned mesh" };
    if (survey.hasMorph) return { triangleCount: survey.totalTris, canDecimate: false, reason: "Morph targets" };
    if (survey.totalTris === 0) return { triangleCount: 0, canDecimate: false, reason: "No triangle geometry" };
    return { triangleCount: survey.totalTris, canDecimate: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { triangleCount: 0, canDecimate: false, reason: message };
  }
}

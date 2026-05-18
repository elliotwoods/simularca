import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Imported CAD/Collada/FBX scenes routinely explode into thousands of tiny
 * sub-meshes (one per CAD face). The WebGPU backend pays a per-object CPU cost
 * every frame (matrix update, cull, bind-group prep) that scales with object
 * count, so a 4k-object building can cost ~80ms/frame even when it is just
 * static geometry. Merging static sub-meshes that share a material into a
 * handful of draw objects removes that per-object tax.
 *
 * Only safe for static geometry: callers MUST skip skinned/morph/animated
 * imports (their per-node transforms are animated and cannot be baked).
 */

const CANONICAL_ATTRS = ["position", "normal", "uv", "uv1", "uv2", "color", "tangent"];

function hex(value: unknown): string {
  const c = value as { getHexString?: () => string } | undefined;
  return c && typeof c.getHexString === "function" ? c.getHexString() : "";
}

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "";
}

/**
 * Dedupe key for visually-equivalent materials. Loaders frequently create one
 * distinct material instance per face even when they are identical, which
 * would otherwise defeat the merge entirely.
 */
function materialKey(m: THREE.Material): string {
  const a = m as unknown as Record<string, unknown>;
  return [
    m.type,
    hex(a.color),
    hex(a.emissive),
    (a.map as { uuid?: string } | undefined)?.uuid ?? "",
    (a.normalMap as { uuid?: string } | undefined)?.uuid ?? "",
    (a.roughnessMap as { uuid?: string } | undefined)?.uuid ?? "",
    (a.metalnessMap as { uuid?: string } | undefined)?.uuid ?? "",
    (a.emissiveMap as { uuid?: string } | undefined)?.uuid ?? "",
    (a.alphaMap as { uuid?: string } | undefined)?.uuid ?? "",
    num(a.roughness),
    num(a.metalness),
    num(a.opacity),
    m.transparent ? "T" : "O",
    String(m.side),
    num(a.alphaTest),
    a.vertexColors ? "vc" : "",
    m.name ?? ""
  ].join("|");
}

function geometryLayoutKey(g: THREE.BufferGeometry): string {
  const names = Object.keys(g.attributes)
    .filter((n) => CANONICAL_ATTRS.includes(n))
    .sort();
  const layout = names.map((n) => `${n}:${g.attributes[n]!.itemSize}`).join(",");
  return `${g.index ? "I" : "N"}|${layout}`;
}

/** Drop non-canonical attributes + morph data so a bucket has a uniform layout. */
function stripToCanonical(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (!CANONICAL_ATTRS.includes(name)) {
      g.deleteAttribute(name);
    }
  }
  g.morphAttributes = {};
  // Groups only matter for multi-material meshes (we already exclude those).
  // For a single material the per-face groups just split it into needless
  // draw calls, defeating the merge — drop them.
  g.clearGroups();
  return g;
}

export interface MeshMergeResult {
  object: THREE.Object3D;
  merged: boolean;
  beforeMeshCount: number;
  afterMeshCount: number;
  beforeMaterialCount: number;
  afterMaterialCount: number;
}

/**
 * Returns a new Object3D where static sub-meshes sharing a (deduped) material
 * and vertex layout are merged into single geometries with world transforms
 * baked in. Falls back to the original object (merged:false) when there is
 * nothing safe to merge.
 */
export function mergeImportedSceneByMaterial(root: THREE.Object3D): MeshMergeResult {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const meshes: THREE.Mesh[] = [];
  let beforeMaterials = 0;
  root.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (mesh.isMesh) {
      meshes.push(mesh);
      beforeMaterials += Array.isArray(mesh.material) ? mesh.material.length : 1;
    }
  });

  const unsafe = meshes.some((m) => {
    const skinned = (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
    const morph = m.geometry && Object.keys(m.geometry.morphAttributes ?? {}).length > 0;
    return skinned || morph;
  });
  if (unsafe || meshes.length < 2) {
    return {
      object: root,
      merged: false,
      beforeMeshCount: meshes.length,
      afterMeshCount: meshes.length,
      beforeMaterialCount: beforeMaterials,
      afterMaterialCount: beforeMaterials
    };
  }

  interface Bucket {
    material: THREE.Material;
    geometries: THREE.BufferGeometry[];
    cast: boolean;
    recv: boolean;
  }
  const buckets = new Map<string, Bucket>();
  const passthrough: THREE.Mesh[] = [];

  for (const mesh of meshes) {
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    const mat = mesh.material;
    if (Array.isArray(mat) || !mat || !geom || !geom.isBufferGeometry) {
      passthrough.push(mesh);
      continue;
    }
    mesh.updateWorldMatrix(true, false);
    const rel = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
    const g = stripToCanonical(geom.clone());
    if (!g.attributes.position) {
      g.dispose();
      continue;
    }
    g.applyMatrix4(rel);
    const key = `${materialKey(mat)}##${geometryLayoutKey(g)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: mat, geometries: [], cast: false, recv: false };
      buckets.set(key, bucket);
    }
    bucket.geometries.push(g);
    bucket.cast = bucket.cast || mesh.castShadow;
    bucket.recv = bucket.recv || mesh.receiveShadow;
  }

  const newRoot = new THREE.Group();
  newRoot.name = root.name || "merged-import";
  newRoot.position.copy(root.position);
  newRoot.quaternion.copy(root.quaternion);
  newRoot.scale.copy(root.scale);

  let afterMeshCount = 0;
  const afterMaterials = new Set<THREE.Material>();

  for (const bucket of buckets.values()) {
    if (bucket.geometries.length === 0) {
      continue;
    }
    let mergedGeom: THREE.BufferGeometry | null = null;
    if (bucket.geometries.length === 1) {
      mergedGeom = bucket.geometries[0]!;
    } else {
      try {
        mergedGeom = mergeGeometries(bucket.geometries, false);
      } catch {
        mergedGeom = null;
      }
    }
    if (!mergedGeom) {
      // Could not merge this bucket — keep its geometries as separate meshes.
      for (const g of bucket.geometries) {
        const m = new THREE.Mesh(g, bucket.material);
        m.castShadow = bucket.cast;
        m.receiveShadow = bucket.recv;
        m.frustumCulled = true;
        newRoot.add(m);
        afterMeshCount += 1;
      }
      afterMaterials.add(bucket.material);
      continue;
    }
    if (bucket.geometries.length > 1) {
      for (const g of bucket.geometries) {
        g.dispose();
      }
    }
    const mesh = new THREE.Mesh(mergedGeom, bucket.material);
    mesh.name = `merged:${bucket.material.name || bucket.material.type}`;
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.recv;
    mesh.frustumCulled = true;
    newRoot.add(mesh);
    afterMeshCount += 1;
    afterMaterials.add(bucket.material);
  }

  for (const mesh of passthrough) {
    mesh.updateWorldMatrix(true, false);
    const rel = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
    const clone = mesh.clone();
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(rel);
    newRoot.add(clone);
    afterMeshCount += 1;
    const cm = clone.material;
    (Array.isArray(cm) ? cm : [cm]).forEach((x) => {
      if (x) {
        afterMaterials.add(x);
      }
    });
  }

  return {
    object: newRoot,
    merged: true,
    beforeMeshCount: meshes.length,
    afterMeshCount,
    beforeMaterialCount: beforeMaterials,
    afterMaterialCount: afterMaterials.size
  };
}

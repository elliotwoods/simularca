/**
 * Spatial chunking for gaussian splat frustum culling.
 *
 * Divides splats into spatial blocks (chunks) using a uniform 3D grid.
 * Each chunk stores conservative local bounds that can be tested against the
 * camera frustum on CPU each frame. Only ~100-200 chunks need testing
 * rather than 100k+ individual splats.
 */

import * as THREE from "three";
import { WebGLCoordinateSystem } from "three";

export interface SplatChunk {
  /** Model-space local AABB min (already expanded by splat extent) */
  min: [number, number, number];
  /** Model-space local AABB max (already expanded by splat extent) */
  max: [number, number, number];
}

export interface ChunkData {
  /** All spatial chunks */
  chunks: SplatChunk[];
  /** Per-splat chunk assignment: chunkIds[splatIndex] = chunkIndex */
  chunkIds: Uint16Array;
  /** Per-chunk splat counts aligned with `chunks` */
  chunkPointCounts: Uint32Array;
}

const SPLATS_PER_CHUNK_TARGET = 256;
const MIN_EXTENT = 0.001;
const SPLAT_SIGMA_EXTENT = 3.0;

function splatExtent(scales: Float32Array, index3: number): number {
  const sx = Math.abs(scales[index3]);
  const sy = Math.abs(scales[index3 + 1]);
  const sz = Math.abs(scales[index3 + 2]);
  return Math.max(sx, sy, sz) * SPLAT_SIGMA_EXTENT;
}

function chunkForIndices(indices: readonly number[], positions: Float32Array, scales: Float32Array): SplatChunk {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const idx of indices) {
    const i3 = idx * 3;
    const x = positions[i3];
    const y = positions[i3 + 1];
    const z = positions[i3 + 2];
    const extent = splatExtent(scales, i3);

    minX = Math.min(minX, x - extent);
    minY = Math.min(minY, y - extent);
    minZ = Math.min(minZ, z - extent);
    maxX = Math.max(maxX, x + extent);
    maxY = Math.max(maxY, y + extent);
    maxZ = Math.max(maxZ, z + extent);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ]
  };
}

function buildSingleChunk(
  positions: Float32Array,
  scales: Float32Array,
  count: number
): ChunkData {
  const indices = Array.from({ length: count }, (_, index) => index);
  return {
    chunks: [chunkForIndices(indices, positions, scales)],
    chunkIds: new Uint16Array(count),
    chunkPointCounts: new Uint32Array([count])
  };
}

/**
 * Build spatial chunks from splat positions and scales.
 *
 * @param positions Float32Array [x,y,z] interleaved, length = count * 3
 * @param scales    Float32Array [sx,sy,sz] interleaved, length = count * 3
 * @param count     Number of splats
 * @returns ChunkData with chunks and per-splat chunk ID assignments
 */
export function buildChunks(
  positions: Float32Array,
  scales: Float32Array,
  count: number
): ChunkData {
  if (count <= 0) {
    return { chunks: [], chunkIds: new Uint16Array(0), chunkPointCounts: new Uint32Array(0) };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const x = positions[i3];
    const y = positions[i3 + 1];
    const z = positions[i3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (count <= SPLATS_PER_CHUNK_TARGET) {
    return buildSingleChunk(positions, scales, count);
  }

  const extentX = Math.max(MIN_EXTENT, maxX - minX);
  const extentY = Math.max(MIN_EXTENT, maxY - minY);
  const extentZ = Math.max(MIN_EXTENT, maxZ - minZ);
  const targetChunkCount = Math.max(1, Math.ceil(count / SPLATS_PER_CHUNK_TARGET));
  const aspectX = extentX / Math.cbrt(extentX * extentY * extentZ);
  const aspectY = extentY / Math.cbrt(extentX * extentY * extentZ);
  const aspectZ = extentZ / Math.cbrt(extentX * extentY * extentZ);
  const baseGrid = Math.cbrt(targetChunkCount);
  const gridX = Math.max(1, Math.round(baseGrid * aspectX));
  const gridY = Math.max(1, Math.round(baseGrid * aspectY));
  const gridZ = Math.max(1, Math.round(baseGrid * aspectZ));
  const cellX = extentX / gridX;
  const cellY = extentY / gridY;
  const cellZ = extentZ / gridZ;

  const bucketMap = new Map<number, number[]>();
  const chunkIds = new Uint16Array(count);

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const x = positions[i3];
    const y = positions[i3 + 1];
    const z = positions[i3 + 2];
    const gx = Math.max(0, Math.min(gridX - 1, Math.floor((x - minX) / cellX)));
    const gy = Math.max(0, Math.min(gridY - 1, Math.floor((y - minY) / cellY)));
    const gz = Math.max(0, Math.min(gridZ - 1, Math.floor((z - minZ) / cellZ)));
    const key = gx + gy * gridX + gz * gridX * gridY;
    const bucket = bucketMap.get(key);
    if (bucket) {
      bucket.push(i);
    } else {
      bucketMap.set(key, [i]);
    }
  }

  const chunks: SplatChunk[] = [];
  const chunkPointCounts: number[] = [];
  let chunkIndex = 0;
  for (const indices of bucketMap.values()) {
    if (indices.length <= 0) {
      continue;
    }
    chunks.push(chunkForIndices(indices, positions, scales));
    chunkPointCounts.push(indices.length);
    for (const idx of indices) {
      chunkIds[idx] = chunkIndex;
    }
    chunkIndex += 1;
  }

  return { chunks, chunkIds, chunkPointCounts: Uint32Array.from(chunkPointCounts) };
}

const _projViewMatrix = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _chunkCorners = Array.from({ length: 8 }, () => new THREE.Vector3());

function setChunkCorners(chunk: SplatChunk): void {
  const [minX, minY, minZ] = chunk.min;
  const [maxX, maxY, maxZ] = chunk.max;

  _chunkCorners[0].set(minX, minY, minZ);
  _chunkCorners[1].set(minX, minY, maxZ);
  _chunkCorners[2].set(minX, maxY, minZ);
  _chunkCorners[3].set(minX, maxY, maxZ);
  _chunkCorners[4].set(maxX, minY, minZ);
  _chunkCorners[5].set(maxX, minY, maxZ);
  _chunkCorners[6].set(maxX, maxY, minZ);
  _chunkCorners[7].set(maxX, maxY, maxZ);
}

function intersectsFrustumAsObb(chunk: SplatChunk, modelWorldMatrix: THREE.Matrix4): boolean {
  setChunkCorners(chunk);
  for (const corner of _chunkCorners) {
    corner.applyMatrix4(modelWorldMatrix);
  }

  for (const plane of _frustum.planes) {
    let allOutside = true;
    for (const corner of _chunkCorners) {
      if (plane.distanceToPoint(corner) >= 0) {
        allOutside = false;
        break;
      }
    }
    if (allOutside) {
      return false;
    }
  }

  return true;
}

/**
 * Update chunk visibility based on camera frustum.
 *
 * @param chunkData     The chunk data from buildChunks()
 * @param camera        Current camera
 * @param modelWorldMatrix The mesh's matrixWorld (includes coordinate correction)
 * @param outVisibility Uint32Array of length numChunks, mutated in place (1 = visible, 0 = culled)
 * @returns Number of visible chunks
 */
export function updateChunkVisibility(
  chunkData: ChunkData,
  camera: THREE.Camera,
  modelWorldMatrix: THREE.Matrix4,
  outVisibility: Uint32Array
): number {
  const { chunks } = chunkData;
  const numChunks = chunks.length;

  _projViewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(
    _projViewMatrix,
    (camera.coordinateSystem as number | undefined) ?? WebGLCoordinateSystem
  );

  let visibleCount = 0;
  for (let i = 0; i < numChunks; i += 1) {
    if (intersectsFrustumAsObb(chunks[i], modelWorldMatrix)) {
      outVisibility[i] = 1;
      visibleCount += 1;
    } else {
      outVisibility[i] = 0;
    }
  }

  return visibleCount;
}

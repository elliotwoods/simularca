/**
 * GPU-based bitonic sort for gaussian splats using Three.js TSL compute shaders.
 *
 * Two compute shader passes:
 * 1. Depth computation — computes view-space Z for each splat, with optional
 *    chunk-based frustum culling (culled splats get sentinel depth → sort to end)
 * 2. Bitonic step — one compare-and-swap step of bitonic merge sort
 *
 * The CPU iterates over (k, j) pairs and dispatches the bitonic step shader
 * for each pair. Each dispatch is a separate renderer.compute() call, which
 * guarantees ordering between steps (separate command buffer submissions).
 *
 * The sortedIndices StorageBufferAttribute is shared between the compute
 * shader (write) and the vertex shader (read) — no CPU↔GPU transfer needed.
 */

import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import {
  Fn,
  storage,
  globalId,
  uniform,
  float,
  int,
  uint,
  vec4,
  dot,
  If,
  select,
} from "three/tsl";

/** Sentinel depth value: frustum-culled splats get this so they sort to the end */
const CULLED_DEPTH = 99999.0;

// Camera movement thresholds
const CAMERA_MOVE_THRESHOLD_POS = 1e-4;
const CAMERA_MOVE_THRESHOLD_QUAT = 1e-4;

// Temporal sort coherence: skip full sort when camera rotates slowly
const SORT_ANGLE_THRESHOLD = 0.02; // ~1.15° — re-sort when exceeded
const MAX_SKIP_FRAMES = 8;         // force sort at least every 9th frame

/** Per-frame sort statistics for inspector status display. */
export interface SortFrameStats {
  sortMode: "full" | "depth-only" | "skipped";
  dispatches: number;
  framesSinceFullSort: number;
  angleSinceSort: number;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class GpuSorter {
  private readonly count: number;
  private readonly paddedCount: number;

  // GPU buffers
  private readonly depthsBuffer: StorageBufferAttribute;

  // Chunk-based frustum culling (optional)
  readonly chunkVisibilityBuffer: StorageBufferAttribute | null;
  private readonly hasCulling: boolean;

  // Compute nodes (created once, reused each frame)
  private readonly depthComputeNode: any;
  private readonly bitonicStepNode: any;

  // Uniforms updated per-frame / per-step
  private readonly uMvRow2: any; // vec4 — row 2 of model-view matrix
  private readonly uK: any;     // int — bitonic step outer param
  private readonly uJ: any;     // int — bitonic step inner param

  // Camera snapshot for movement detection
  private lastCameraPosition = new THREE.Vector3();
  private lastCameraQuaternion = new THREE.Quaternion();
  private hasSortedOnce = false;
  private visibilityDirty = true; // force re-sort when visibility changes

  // Temporal coherence: track camera at last full sort
  private lastSortCameraQuaternion = new THREE.Quaternion();
  private framesSinceSort = 0;

  // Scratch matrix (allocated once)
  private readonly modelViewMatrix = new THREE.Matrix4();

  constructor(
    positionsBuffer: StorageBufferAttribute,
    sortedIndicesBuffer: StorageBufferAttribute,
    count: number,
    chunkIdsBuffer?: StorageBufferAttribute,
    numChunks?: number,
    chunkVisibilityBuffer?: StorageBufferAttribute
  ) {
    this.count = count;
    this.paddedCount = nextPowerOfTwo(count);
    const paddedCount = this.paddedCount;

    // Chunk-based frustum culling setup
    this.hasCulling = !!(chunkIdsBuffer && numChunks && numChunks > 0);
    let chunkIdsStorage: any = null;
    let chunkVisibilityStorage: any = null;

    if (this.hasCulling && chunkIdsBuffer && numChunks && chunkVisibilityBuffer) {
      chunkIdsStorage = storage(chunkIdsBuffer, "uint", count);

      // Use the shared visibility buffer (same StorageBufferAttribute as material)
      this.chunkVisibilityBuffer = chunkVisibilityBuffer;
      chunkVisibilityStorage = storage(this.chunkVisibilityBuffer, "uint", numChunks);
    } else {
      this.chunkVisibilityBuffer = null;
    }

    // Create depths scratch buffer (float per padded element)
    const depthsData = new Float32Array(paddedCount);
    // Initialize padding depths to large positive value (sorts to end in ascending order)
    for (let i = count; i < paddedCount; i++) {
      depthsData[i] = CULLED_DEPTH;
    }
    this.depthsBuffer = new StorageBufferAttribute(depthsData, 1);

    // Create TSL storage nodes
    const positionsStorage: any = storage(positionsBuffer, "vec4", count);
    const depthsStorage: any = storage(this.depthsBuffer, "float", paddedCount);
    const sortedIndicesStorage: any = storage(sortedIndicesBuffer, "uint", paddedCount);

    // Uniforms
    this.uMvRow2 = uniform(new THREE.Vector4(0, 0, -1, 0));
    this.uK = uniform(uint(0));
    this.uJ = uniform(uint(0));

    // -----------------------------------------------------------------------
    // Compute shader 1: depth computation (with optional chunk frustum culling)
    // -----------------------------------------------------------------------
    const hasCullingFlag = this.hasCulling;

    const depthComputeFn = Fn(() => {
      const gid: any = globalId.x;

      // Guard: only process valid indices
      If(gid.greaterThanEqual(uint(paddedCount)), () => {
        return;
      });

      // Real splats: compute view-space Z
      If(gid.lessThan(uint(count)), () => {
        const pos: any = positionsStorage.element(gid).xyz;
        const mvRow2: any = this.uMvRow2;
        // depth = dot(mvRow2.xyz, pos) + mvRow2.w
        const depth: any = mvRow2.x.mul(pos.x)
          .add(mvRow2.y.mul(pos.y))
          .add(mvRow2.z.mul(pos.z))
          .add(mvRow2.w);

        if (hasCullingFlag && chunkIdsStorage && chunkVisibilityStorage) {
          // Check chunk visibility: read chunkId, look up visibility
          const chunkId: any = chunkIdsStorage.element(gid);
          const visible: any = chunkVisibilityStorage.element(chunkId);
          // If chunk not visible, assign sentinel depth to push to end of sort
          depthsStorage.element(gid).assign(
            select(visible.equal(uint(1)), depth, float(CULLED_DEPTH))
          );
        } else {
          depthsStorage.element(gid).assign(depth);
        }
      });

      // Padding: assign large depth so they sort to the end (ascending)
      If(gid.greaterThanEqual(uint(count)), () => {
        depthsStorage.element(gid).assign(float(CULLED_DEPTH));
      });
    });

    this.depthComputeNode = depthComputeFn().compute(paddedCount, [256]);

    // -----------------------------------------------------------------------
    // Compute shader 2: bitonic compare-and-swap step
    // -----------------------------------------------------------------------
    const bitonicStepFn = Fn(() => {
      const gid: any = globalId.x;

      // Guard: only process valid indices
      If(gid.greaterThanEqual(uint(paddedCount)), () => {
        return;
      });

      const k: any = this.uK;
      const j: any = this.uJ;

      // Partner index for this thread
      const partner: any = gid.bitXor(j).toVar("partner");

      // Only the lower-index thread does the swap (avoid double-swap)
      If(partner.greaterThan(gid), () => {
        // Read current indices
        const idxA: any = sortedIndicesStorage.element(gid).toVar("idxA");
        const idxB: any = sortedIndicesStorage.element(partner).toVar("idxB");

        // Read depths for the indexed splats
        const depthA: any = depthsStorage.element(idxA).toVar("depthA");
        const depthB: any = depthsStorage.element(idxB).toVar("depthB");

        // Determine sort direction for this pair
        // Ascending sort (back-to-front): most negative Z first
        // Direction: ascending when (gid & k) == 0, descending otherwise
        const ascending: any = gid.bitAnd(k).equal(uint(0));

        // Should swap?
        // If ascending and depthA > depthB → swap
        // If descending and depthA < depthB → swap
        const needSwap: any = select(
          ascending,
          depthA.greaterThan(depthB),
          depthA.lessThan(depthB)
        );

        If(needSwap, () => {
          sortedIndicesStorage.element(gid).assign(idxB);
          sortedIndicesStorage.element(partner).assign(idxA);
        });
      });
    });

    this.bitonicStepNode = bitonicStepFn().compute(paddedCount, [256]);
  }

  /**
   * Update the chunk visibility buffer from CPU-side frustum culling results.
   * Call this before sort() each frame.
   */
  updateChunkVisibility(visibility: Uint32Array): void {
    if (!this.chunkVisibilityBuffer) return;
    const arr = this.chunkVisibilityBuffer.array as Uint32Array;
    // Only mark dirty if data actually changed (avoid forcing full sort every frame)
    let changed = false;
    for (let i = 0; i < visibility.length; i++) {
      if (arr[i] !== visibility[i]) { changed = true; break; }
    }
    arr.set(visibility);
    this.chunkVisibilityBuffer.needsUpdate = true;
    if (changed) this.visibilityDirty = true;
  }

  /**
   * Run the GPU sort if the camera has moved or visibility changed.
   * Called from onBeforeRender with the renderer and camera.
   */
  sort(renderer: any, camera: THREE.Camera, modelWorldMatrix: THREE.Matrix4): SortFrameStats {
    // Guard: renderer.compute may not be available during scene transitions
    if (typeof renderer.compute !== "function") {
      return { sortMode: "skipped", dispatches: 0, framesSinceFullSort: this.framesSinceSort, angleSinceSort: 0 };
    }

    const angleSinceSort = this.hasSortedOnce ? this.angleSinceLastSort(camera) : 0;

    const cameraMoved = this.hasCameraMoved(camera);
    if (!cameraMoved && !this.visibilityDirty && this.hasSortedOnce) {
      return { sortMode: "skipped", dispatches: 0, framesSinceFullSort: this.framesSinceSort, angleSinceSort };
    }

    // Compute model-view matrix and extract row 2 (Z axis in view space)
    this.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, modelWorldMatrix);
    const me = this.modelViewMatrix.elements;
    this.uMvRow2.value.set(me[2], me[6], me[10], me[14]);

    // Always recompute depths (1 dispatch — cheap)
    renderer.compute(this.depthComputeNode);
    let dispatches = 1;

    // Temporal coherence: decide if full sort is needed
    this.framesSinceSort++;
    const needsFullSort = !this.hasSortedOnce
      || this.visibilityDirty
      || angleSinceSort > SORT_ANGLE_THRESHOLD
      || this.framesSinceSort >= MAX_SKIP_FRAMES;

    if (needsFullSort) {
      // Full bitonic sort
      const n = this.paddedCount;
      for (let k = 2; k <= n; k *= 2) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          this.uK.value = k;
          this.uJ.value = j;
          renderer.compute(this.bitonicStepNode);
          dispatches++;
        }
      }
      this.framesSinceSort = 0;
      this.lastSortCameraQuaternion.copy(camera.quaternion);
    }

    const sortMode = needsFullSort ? "full" as const : "depth-only" as const;

    // Save camera snapshot for movement detection
    this.lastCameraPosition.copy(camera.position);
    this.lastCameraQuaternion.copy(camera.quaternion);
    this.hasSortedOnce = true;
    this.visibilityDirty = false;

    return { sortMode, dispatches, framesSinceFullSort: this.framesSinceSort, angleSinceSort };
  }

  private hasCameraMoved(camera: THREE.Camera): boolean {
    const dp = this.lastCameraPosition.distanceToSquared(camera.position);
    if (dp > CAMERA_MOVE_THRESHOLD_POS) return true;

    const dq =
      Math.abs(camera.quaternion.x - this.lastCameraQuaternion.x) +
      Math.abs(camera.quaternion.y - this.lastCameraQuaternion.y) +
      Math.abs(camera.quaternion.z - this.lastCameraQuaternion.z) +
      Math.abs(camera.quaternion.w - this.lastCameraQuaternion.w);
    return dq > CAMERA_MOVE_THRESHOLD_QUAT;
  }

  /** Angular distance (radians) between current camera and last full sort. */
  private angleSinceLastSort(camera: THREE.Camera): number {
    const dot = Math.abs(
      camera.quaternion.x * this.lastSortCameraQuaternion.x +
      camera.quaternion.y * this.lastSortCameraQuaternion.y +
      camera.quaternion.z * this.lastSortCameraQuaternion.z +
      camera.quaternion.w * this.lastSortCameraQuaternion.w
    );
    return 2 * Math.acos(Math.min(dot, 1.0));
  }

  dispose(): void {
    // StorageBufferAttribute doesn't have a dispose method,
    // but the GPU buffer will be freed when references are released
  }
}

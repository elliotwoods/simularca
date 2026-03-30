/**
 * GPU-based bitonic sort for gaussian splats using Three.js TSL compute shaders.
 *
 * Four compute shader kernels:
 * 1. Depth computation — view-space Z per splat, with optional chunk frustum culling
 * 2. Bitonic step — one global compare-and-swap step (for j >= WG_SIZE)
 * 3. Local sort — sorts each 256-element block using shared memory (k=2..256)
 * 4. Local merge — merges within workgroups for a given k using shared memory
 *
 * The local sort + local merge kernels batch multiple j-steps into single
 * dispatches using workgroupArray + workgroupBarrier, reducing dispatch count
 * from ~210 to ~92 for 1M splats (56% fewer renderer.compute() calls).
 *
 * Combined with temporal coherence (skip full sort on small camera moves),
 * most frames only need 0-1 dispatches.
 */

import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import {
  Fn,
  storage,
  globalId,
  localId,
  workgroupId,
  uniform,
  float,
  uint,
  If,
  select,
  workgroupArray,
  workgroupBarrier,
} from "three/tsl";
import { classifyWorldTransformChange, type ModelChangeKind } from "./transformInvalidation";

/** Sentinel depth value: frustum-culled splats get this so they sort to the end */
const CULLED_DEPTH = 99999.0;

/** Workgroup size for all compute shaders */
const WG_SIZE = 256;

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
  modelChange: ModelChangeKind;
  viewDirty: boolean;
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
  private readonly localSortNode: any;   // sorts 256-element blocks (k=2..WG_SIZE)
  private readonly localMergeNode: any;  // merges within workgroups for given uK

  // Uniforms updated per-frame / per-step
  private readonly uMvRow2: any; // vec4 — row 2 of model-view matrix
  private readonly uK: any;     // int — bitonic step outer param
  private readonly uJ: any;     // int — bitonic step inner param

  // Camera snapshot for movement detection
  private lastCameraPosition = new THREE.Vector3();
  private lastCameraQuaternion = new THREE.Quaternion();
  private hasSortedOnce = false;
  private visibilityDirty = true; // force re-sort when visibility changes
  private readonly lastModelMatrix = new THREE.Matrix4();
  private hasModelSnapshot = false;

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

    this.depthComputeNode = depthComputeFn().compute(paddedCount, [WG_SIZE]);

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

    this.bitonicStepNode = bitonicStepFn().compute(paddedCount, [WG_SIZE]);

    // -----------------------------------------------------------------------
    // Compute shader 3: local bitonic sort (sorts each 256-element block)
    // Replaces k=2..WG_SIZE steps (36 dispatches → 1 dispatch)
    // -----------------------------------------------------------------------
    const localSortFn = Fn(() => {
      const lid: any = localId.x;
      const blockStart: any = workgroupId.x.mul(uint(WG_SIZE));
      const gid: any = blockStart.add(lid);

      // Shared memory for indices and depths
      const sharedIdx: any = workgroupArray("uint", WG_SIZE);
      const sharedDep: any = workgroupArray("float", WG_SIZE);

      // Load from global memory
      sharedIdx.element(lid).assign(sortedIndicesStorage.element(gid));
      sharedDep.element(lid).assign(depthsStorage.element(sharedIdx.element(lid)));
      workgroupBarrier();

      // Unrolled bitonic sort for k=2..WG_SIZE (36 steps, generated at shader build time)
      let step = 0;
      for (let k = 2; k <= WG_SIZE; k *= 2) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          const s = step++;
          const partner: any = lid.bitXor(uint(j));

          If(partner.greaterThan(lid), () => {
            const ascending: any = lid.bitAnd(uint(k)).equal(uint(0));
            const dA: any = sharedDep.element(lid).toVar(`dA${s}`);
            const dB: any = sharedDep.element(partner).toVar(`dB${s}`);
            const needSwap: any = select(ascending, dA.greaterThan(dB), dA.lessThan(dB));

            If(needSwap, () => {
              // Swap indices
              const tmpI: any = sharedIdx.element(lid).toVar(`tI${s}`);
              sharedIdx.element(lid).assign(sharedIdx.element(partner));
              sharedIdx.element(partner).assign(tmpI);
              // Swap depths
              const tmpD: any = sharedDep.element(lid).toVar(`tD${s}`);
              sharedDep.element(lid).assign(sharedDep.element(partner));
              sharedDep.element(partner).assign(tmpD);
            });
          });
          workgroupBarrier();
        }
      }

      // Write back to global memory
      sortedIndicesStorage.element(gid).assign(sharedIdx.element(lid));
    });

    this.localSortNode = localSortFn().compute(paddedCount, [WG_SIZE]);

    // -----------------------------------------------------------------------
    // Compute shader 4: local bitonic merge (j < WG_SIZE steps for a given k)
    // Replaces 8 dispatches → 1 dispatch per k-value
    // -----------------------------------------------------------------------
    const localMergeFn = Fn(() => {
      const lid: any = localId.x;
      const blockStart: any = workgroupId.x.mul(uint(WG_SIZE));
      const gid: any = blockStart.add(lid);

      // Shared memory
      const sharedIdx: any = workgroupArray("uint", WG_SIZE);
      const sharedDep: any = workgroupArray("float", WG_SIZE);

      // Load from global memory
      sharedIdx.element(lid).assign(sortedIndicesStorage.element(gid));
      sharedDep.element(lid).assign(depthsStorage.element(sharedIdx.element(lid)));
      workgroupBarrier();

      // Ascending direction uses global index and uK (set per-dispatch)
      const ascending: any = gid.bitAnd(this.uK).equal(uint(0));

      // Unrolled merge steps for j = WG_SIZE/2 down to 1 (8 steps)
      let mStep = 0;
      for (let j = WG_SIZE >> 1; j > 0; j >>= 1) {
        const ms = mStep++;
        const partner: any = lid.bitXor(uint(j));

        If(partner.greaterThan(lid), () => {
          const dA: any = sharedDep.element(lid).toVar(`mdA${ms}`);
          const dB: any = sharedDep.element(partner).toVar(`mdB${ms}`);
          const needSwap: any = select(ascending, dA.greaterThan(dB), dA.lessThan(dB));

          If(needSwap, () => {
            const tmpI: any = sharedIdx.element(lid).toVar(`mtI${ms}`);
            sharedIdx.element(lid).assign(sharedIdx.element(partner));
            sharedIdx.element(partner).assign(tmpI);
            const tmpD: any = sharedDep.element(lid).toVar(`mtD${ms}`);
            sharedDep.element(lid).assign(sharedDep.element(partner));
            sharedDep.element(partner).assign(tmpD);
          });
        });
        workgroupBarrier();
      }

      // Write back
      sortedIndicesStorage.element(gid).assign(sharedIdx.element(lid));
    });

    this.localMergeNode = localMergeFn().compute(paddedCount, [WG_SIZE]);
  }

  /**
   * Update the chunk visibility buffer from CPU-side frustum culling results.
   * Call this before sort() each frame.
   */
  updateChunkVisibility(visibility: Uint32Array): boolean {
    if (!this.chunkVisibilityBuffer) return false;
    const arr = this.chunkVisibilityBuffer.array as Uint32Array;
    // Only mark dirty if data actually changed (avoid forcing full sort every frame)
    let changed = false;
    for (let i = 0; i < visibility.length; i++) {
      if (arr[i] !== visibility[i]) { changed = true; break; }
    }
    arr.set(visibility);
    this.chunkVisibilityBuffer.needsUpdate = true;
    if (changed) this.visibilityDirty = true;
    return changed;
  }

  /**
   * Run the GPU sort if the camera has moved or visibility changed.
   * Called from onBeforeRender with the renderer and camera.
   */
  sort(renderer: any, camera: THREE.Camera, modelWorldMatrix: THREE.Matrix4): SortFrameStats {
    // Guard: renderer.compute may not be available during scene transitions
    if (typeof renderer.compute !== "function") {
      return {
        sortMode: "skipped",
        dispatches: 0,
        framesSinceFullSort: this.framesSinceSort,
        angleSinceSort: 0,
        modelChange: "none",
        viewDirty: false
      };
    }

    const modelChange = classifyWorldTransformChange(
      this.hasModelSnapshot ? this.lastModelMatrix : null,
      modelWorldMatrix
    );
    const angleSinceSort = this.hasSortedOnce ? this.angleSinceLastSort(camera) : 0;

    const cameraMoved = this.hasCameraMoved(camera);
    const viewDirty = !this.hasSortedOnce || cameraMoved || this.visibilityDirty || modelChange !== "none";
    if (!cameraMoved && !this.visibilityDirty && modelChange === "none" && this.hasSortedOnce) {
      this.lastModelMatrix.copy(modelWorldMatrix);
      this.hasModelSnapshot = true;
      return {
        sortMode: "skipped",
        dispatches: 0,
        framesSinceFullSort: this.framesSinceSort,
        angleSinceSort,
        modelChange,
        viewDirty
      };
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
      || modelChange === "full-sort"
      || angleSinceSort > SORT_ANGLE_THRESHOLD
      || this.framesSinceSort >= MAX_SKIP_FRAMES;

    if (needsFullSort) {
      const n = this.paddedCount;

      if (n >= WG_SIZE) {
        // Optimized path: local sort + global merge with local merge
        // Phase 1: sort each 256-element block (replaces k=2..256 steps)
        renderer.compute(this.localSortNode);
        dispatches++;

        // Phase 2: global merge for k > WG_SIZE
        for (let k = WG_SIZE * 2; k <= n; k *= 2) {
          // Global j-steps (j >= WG_SIZE: pairs span workgroups)
          for (let j = k >> 1; j >= WG_SIZE; j >>= 1) {
            this.uK.value = k;
            this.uJ.value = j;
            renderer.compute(this.bitonicStepNode);
            dispatches++;
          }
          // Local merge (j = WG_SIZE/2 down to 1 in one dispatch)
          this.uK.value = k;
          renderer.compute(this.localMergeNode);
          dispatches++;
        }
      } else {
        // Fallback for tiny arrays: use original global bitonic sort
        for (let k = 2; k <= n; k *= 2) {
          for (let j = k >> 1; j > 0; j >>= 1) {
            this.uK.value = k;
            this.uJ.value = j;
            renderer.compute(this.bitonicStepNode);
            dispatches++;
          }
        }
      }

      this.framesSinceSort = 0;
      this.lastSortCameraQuaternion.copy(camera.quaternion);
    }

    const sortMode = needsFullSort ? "full" as const : "depth-only" as const;

    // Save camera snapshot for movement detection
    this.lastCameraPosition.copy(camera.position);
    this.lastCameraQuaternion.copy(camera.quaternion);
    this.lastModelMatrix.copy(modelWorldMatrix);
    this.hasModelSnapshot = true;
    this.hasSortedOnce = true;
    this.visibilityDirty = false;

    return {
      sortMode,
      dispatches,
      framesSinceFullSort: this.framesSinceSort,
      angleSinceSort,
      modelChange,
      viewDirty
    };
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

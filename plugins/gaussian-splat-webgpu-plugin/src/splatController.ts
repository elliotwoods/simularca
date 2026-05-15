/**
 * SplatController — orchestrates the load → parse → GPU upload → render lifecycle
 * for a single gaussian splat actor in the WebGPU plugin.
 *
 * Follows the same async load-token pattern as SparkSplatController to guard
 * against stale load completions when the user swaps assets rapidly.
 *
 * Current pipeline:
 *   - Rendering: InstancedBufferGeometry + instanceIndex (4 verts/splat, instanced)
 *   - Sorting: GPU bitonic sort with temporal coherence (skip sort on small camera moves)
 *   - Culling: chunk-based frustum culling (CPU visibility → GPU upload)
 *   - Projection: compute pre-pass (Cov3D → Cov2D once per splat, not 4× per vertex)
 *
 * IMPORTANT for future optimization work:
 *   - Vertex pulling (vertexIndex + flat draw) was attempted but produced blank output.
 *     Three.js WebGPU may not support non-instanced draws with vertexIndex correctly.
 *   - Radix sort was attempted but Three.js TSL workgroupArray("uint") does not produce
 *     atomic<u32> WGSL types, so atomicAdd on workgroup shared memory fails.
 *   - Compute pre-pass (Cov3D→Cov2D in compute shader) was coded but never validated.
 *   - Any rendering pipeline change (geometry type, shader structure, buffer layout)
 *     MUST be tested incrementally — only one change at a time.
 *   - The status object (setActorStatus) should reflect current sort method and any
 *     operational parameters so they are visible in the inspector.
 */

import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import { tryParseSplatBinary } from "./splatBinaryFormat";
import { parsePlyGaussianData } from "./plyParser";
import { precomputeCovariances, computeBounds } from "./mathUtils";
import { createSplatMaterial, type SplatBuffers, type SplatUniforms } from "./splatMaterial";
import { GpuSorter, type SortFrameStats } from "./splatGpuSort";
import { SplatProjection } from "./splatProjection";
import { buildChunks, updateChunkVisibility, type ChunkData } from "./splatChunks";
import { sanitizeCameraNear } from "./projectionDepth";
import {
  captureCameraProjectionSnapshot,
  hasCameraProjectionChanged,
  type CameraProjectionSnapshot
} from "./cameraInvalidation";

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

const COLOR_SPACE_LINEAR = 0;
const COLOR_SPACE_SRGB = 1;
const COLOR_SPACE_IPHONE_SDR = 2;
const COLOR_SPACE_APPLE_LOG = 3;

/** Context shape passed from syncObject (matches plugin SceneHookContext subset). */
interface SyncContext {
  actor: { id: string; params: Record<string, unknown> };
  object: unknown;
  profileChunk?<T>(label: string, run: () => T): T;
  setActorStatus(status: unknown): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
}

export class SplatController {
  private readonly renderRoot: THREE.Group;

  // Load state
  private loadedAssetId = "";
  private pendingAssetId = "";
  private loadToken = 0;

  // Rendering state (null until first successful load)
  private mesh: THREE.Mesh | null = null;
  private buffers: SplatBuffers | null = null;
  private uniforms: SplatUniforms | null = null;
  private pointCount = 0;
  private bounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
  private positionsData4: Float32Array | null = null;

  // GPU sorting state
  private gpuSorter: GpuSorter | null = null;

  // Compute pre-pass for Cov2D projection (runs 1× per splat instead of 4× in vertex shader)
  private splatProjection: SplatProjection | null = null;
  private currentSplatSizeScale = 1;

  // Cached to avoid per-frame allocation
  private readonly _cachedViewportSize = new THREE.Vector2();

  // Chunk-based frustum culling state
  private chunkData: ChunkData | null = null;
  private chunkVisibilityArray: Uint32Array | null = null;
  private lastVisibleChunks = 0;
  private lastChunkKeptSplats = 0;
  private lastExactVisibleCenters = 0;

  // Per-frame status reporting
  private setActorStatusRef: ((status: unknown) => void) | null = null;
  private profileChunkRef: (<T>(label: string, run: () => T) => T) | null = null;
  private lastSortStats: SortFrameStats | null = null;
  private statusFrameCounter = 0;
  private lastReportedSortMode = "";

  private lastProjectionSnapshot: CameraProjectionSnapshot | null = null;

  constructor(renderRoot: THREE.Group) {
    this.renderRoot = renderRoot;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called once per frame from syncObject.  Synchronous — any async loading is
   * kicked off as fire-and-forget.
   */
  sync(context: SyncContext): void {
    const params = context.actor.params;
    const assetId = typeof params.assetId === "string" ? params.assetId : "";
    const scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : 1;
    const opacity = typeof params.opacity === "number" ? params.opacity : 1;
    const brightness = typeof params.brightness === "number" ? params.brightness : 1;
    const colorInputSpace = typeof params.colorInputSpace === "string" ? params.colorInputSpace : "srgb";
    const splatSizeScale = typeof params.splatSizeScale === "number" ? params.splatSizeScale : 1;

    // Save reference for per-frame status updates
    this.setActorStatusRef = context.setActorStatus;
    this.profileChunkRef = context.profileChunk ?? null;

    // Asset cleared
    if (!assetId) {
      if (this.loadedAssetId || this.pendingAssetId) {
        this.disposeRendering();
        this.loadedAssetId = "";
        this.pendingAssetId = "";
        context.setActorStatus(null);
      }
      return;
    }

    // Asset changed — kick off async load
    if (assetId !== this.loadedAssetId && assetId !== this.pendingAssetId) {
      this.pendingAssetId = assetId;
      this.runProfileChunk("Asset load request", () => {
        void this.loadAsset(assetId, context.readAssetBytes, context.setActorStatus);
      });
    }

    // Update uniforms if mesh is live
    if (this.mesh && this.uniforms) {
      this.runProfileChunk("Uniform update", () => {
        this.updateUniforms(opacity, brightness, scaleFactor, splatSizeScale, colorInputSpace);
      });
    }
  }

  dispose(): void {
    this.loadToken++;
    this.disposeRendering();
    this.loadedAssetId = "";
    this.pendingAssetId = "";
    this.profileChunkRef = null;
  }

  // ---------------------------------------------------------------------------
  // Async loading
  // ---------------------------------------------------------------------------

  private async loadAsset(
    assetId: string,
    readAssetBytes: (id: string) => Promise<Uint8Array>,
    setActorStatus: (status: unknown) => void
  ): Promise<void> {
    const localToken = ++this.loadToken;

    setActorStatus({
      values: {
        backend: "webgpu-tsl",
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });

    try {
      const rawBytes = await readAssetBytes(assetId);

      // Stale guard
      if (this.loadToken !== localToken) return;

      // Unwrap SPLT header if present
      const parsed = tryParseSplatBinary(rawBytes);
      const plyBytes = parsed ? parsed.payload : rawBytes;

      // Parse PLY
      const data = parsePlyGaussianData(plyBytes);
      if (data.count === 0) {
        throw new Error("PLY file contains 0 vertices");
      }

      // Stale guard (parsing can take a while for large files)
      if (this.loadToken !== localToken) return;

      // Precompute covariances
      const cov = precomputeCovariances(data.scales, data.rotations, data.count);
      const bounds = computeBounds(data.positions, data.count);

      // Build spatial chunks for frustum culling
      const chunkData = buildChunks(data.positions, data.scales, data.count);
      const numChunks = chunkData.chunks.length;

      // Build storage buffer data arrays
      const count = data.count;

      // IMPORTANT: WGSL array<vec3<f32>> has 16-byte stride (not 12), so we
      // must pad all vec3 data to vec4 (4 floats per element) to avoid
      // misaligned reads on the GPU after element 0.

      // Positions: pad [x,y,z] → [x,y,z,0] per splat
      const positionsData4 = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const i4 = i * 4;
        positionsData4[i4] = data.positions[i3];
        positionsData4[i4 + 1] = data.positions[i3 + 1];
        positionsData4[i4 + 2] = data.positions[i3 + 2];
        positionsData4[i4 + 3] = 0;
      }

      // covA = [c00, c01, c02, 0] per splat (padded to vec4)
      const covAData = new Float32Array(count * 4);
      // covB = [c11, c12, c22, 0] per splat (padded to vec4)
      const covBData = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const i6 = i * 6;
        const i4 = i * 4;
        covAData[i4] = cov[i6];         // c00
        covAData[i4 + 1] = cov[i6 + 1]; // c01
        covAData[i4 + 2] = cov[i6 + 2]; // c02
        covAData[i4 + 3] = 0;           // padding
        covBData[i4] = cov[i6 + 3];     // c11
        covBData[i4 + 1] = cov[i6 + 4]; // c12
        covBData[i4 + 2] = cov[i6 + 5]; // c22
        covBData[i4 + 3] = 0;           // padding
      }

      // Pack parser-produced colors + per-splat opacity into vec4.
      // Color-space conversion is applied in the GPU shader so the selected
      // input space can be changed at runtime without rebuilding buffers.
      const colorsData = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const i4 = i * 4;
        colorsData[i4] = data.colors[i3];
        colorsData[i4 + 1] = data.colors[i3 + 1];
        colorsData[i4 + 2] = data.colors[i3 + 2];
        colorsData[i4 + 3] = data.opacities[i];
      }

      // Identity sort order, padded to next power of 2 for bitonic sort
      const paddedCount = nextPowerOfTwo(count);
      const sortedIndicesData = new Uint32Array(paddedCount);
      for (let i = 0; i < count; i++) {
        sortedIndicesData[i] = i;
      }
      // Padding indices point to index 0 (won't be rendered due to instanceCount)
      // Their depths will be set to +99999 by the GPU sort, pushing them to the end

      // Create chunk ID storage buffer (per-splat → chunk index)
      // Use Uint32Array for GPU storage even though Uint16 would suffice — WebGPU
      // storage buffers work best with 4-byte aligned element types
      const chunkIdsData = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        chunkIdsData[i] = chunkData.chunkIds[i];
      }
      const chunkIdsAttr = new StorageBufferAttribute(chunkIdsData, 1);

      // Create chunk visibility buffer (per-chunk: 1=visible, 0=culled)
      const visibilityArray = new Uint32Array(numChunks);
      visibilityArray.fill(1); // initially all visible
      const chunkVisibilityAttr = new StorageBufferAttribute(visibilityArray, 1);

      // Create storage buffer attributes (vec4 for positions/covA/covB to match WGSL alignment)
      const positionsAttr = new StorageBufferAttribute(positionsData4, 4);
      const sortedIndicesAttr = new StorageBufferAttribute(sortedIndicesData, 1);
      const buffers: SplatBuffers = {
        positions: positionsAttr,
        covA: new StorageBufferAttribute(covAData, 4),
        covB: new StorageBufferAttribute(covBData, 4),
        colors: new StorageBufferAttribute(colorsData, 4),
        sortedIndices: sortedIndicesAttr,
        chunkIds: chunkIdsAttr,
        chunkVisibility: chunkVisibilityAttr
      };

      // Create compute pre-pass, material, and GPU sorter
      // Wrapped in try-catch for cleaner error reporting if shader compilation fails
      let material: THREE.Material;
      let uniforms: SplatUniforms;
      let gpuSorter: GpuSorter;
      let splatProjection: SplatProjection | null = null;
      try {
        // Compute pre-pass: project Cov3D → Cov2D once per splat (not 4× per vertex)
        splatProjection = new SplatProjection(
          positionsAttr,
          buffers.covA,
          buffers.covB,
          count,
          chunkIdsAttr,
          numChunks,
          chunkVisibilityAttr
        );

        // Attach precomputed ellipse buffers so material uses lightweight vertex shader
        buffers.ellipseA = splatProjection.ellipseABuffer;
        buffers.ellipseB = splatProjection.ellipseBBuffer;

        const result = createSplatMaterial(buffers, count, paddedCount, numChunks);
        material = result.material;
        uniforms = result.uniforms;
        gpuSorter = new GpuSorter(
          positionsAttr,
          sortedIndicesAttr,
          count,
          chunkIdsAttr,
          numChunks,
          chunkVisibilityAttr
        );
      } catch (shaderError) {
        throw new Error(
          `[gsplat-webgpu] Shader/compute creation failed. ` +
          `This plugin requires the WebGPU render engine. ` +
          `Error: ${shaderError instanceof Error ? shaderError.message : String(shaderError)}`
        );
      }

      // Create instanced geometry (quad: 4 vertices, 2 triangles)
      const geometry = new THREE.InstancedBufferGeometry();
      const quadPositions = new Float32Array([
        -1, -1, 0,
         1, -1, 0,
         1,  1, 0,
        -1,  1, 0
      ]);
      const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      geometry.setAttribute("position", new THREE.BufferAttribute(quadPositions, 3));
      geometry.setIndex(new THREE.BufferAttribute(quadIndices, 1));
      geometry.instanceCount = count;

      // Create mesh
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.name = "gsplat-webgpu-mesh";

      if (this.loadToken !== localToken) {
        mesh.removeFromParent();
        geometry.dispose();
        material.dispose();
        splatProjection?.dispose();
        gpuSorter.dispose();
        return;
      }

      // Dispose any previous rendering only after the new mesh is ready and
      // this load is still current. That avoids blanking the live scene if the
      // user switches renderers while a large splat is still loading.
      this.disposeRendering();

      // Store state before setting up onBeforeRender (needs references)
      this.mesh = mesh;
      this.buffers = buffers;
      this.uniforms = uniforms;
      this.pointCount = count;
      this.positionsData4 = positionsData4;
      this.bounds = bounds;
      this.gpuSorter = gpuSorter;
      this.splatProjection = splatProjection;
      this.chunkData = chunkData;
      this.chunkVisibilityArray = visibilityArray;
      this.lastVisibleChunks = numChunks;
      this.lastChunkKeptSplats = count;
      this.lastExactVisibleCenters = count;
      this.loadedAssetId = assetId;
      this.pendingAssetId = "";

      // onBeforeRender: update focal lengths from camera, frustum cull, & sort
      mesh.onBeforeRender = (
        renderer: any,
        _scene: THREE.Scene,
        camera: THREE.Camera
      ) => {
        this.updateFromCamera(camera, renderer);
      };

      // Add to scene
      this.renderRoot.add(mesh);

      // Report success
      setActorStatus({
        values: {
          backend: "webgpu-tsl",
          loadState: "loaded",
          pointCount: count,
          boundsMin: bounds.min,
          boundsMax: bounds.max,
          colorSource: data.colorSource,
          sortMethod: "gpu-bitonic-temporal",
          temporalCoherence: `angle=${0.01}rad, maxSkip=${4}`,
          projectionPrepass: splatProjection !== null,
          chunkCount: numChunks,
          visibleChunks: numChunks,
          chunkKeptSplats: count,
          chunkCulledSplats: 0,
          chunkKeptRatio: 1,
          exactVisibleCenters: count,
          exactVisibleRatio: 1,
          cullingDebug: "chunk-local-obb"
        },
        updatedAtIso: new Date().toISOString()
      });
    } catch (error) {
      // Stale guard
      if (this.loadToken !== localToken) return;

      this.pendingAssetId = "";
      const message = error instanceof Error ? error.message : String(error);

      setActorStatus({
        values: {
          backend: "webgpu-tsl",
          loadState: "failed"
        },
        error: message,
        updatedAtIso: new Date().toISOString()
      });

      console.error(`[gsplat-webgpu] Load failed: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame camera + sort updates (called from onBeforeRender)
  // ---------------------------------------------------------------------------

  private updateFromCamera(camera: THREE.Camera, renderer: any): void {
    if (!this.uniforms) return;

    // Update viewport size from renderer
    // Prefer getDrawingBufferSize (actual rendering resolution) over getSize (CSS pixels)
    // to match the coordinate space the projection matrix was built against
    let focalX = 0;
    let focalY = 0;
    let isOrthographic = false;
    let cameraNear = 0;
    this.runProfileChunk("Viewport size", () => {
      const size = this._cachedViewportSize;
      if (typeof renderer.getDrawingBufferSize === "function") {
        renderer.getDrawingBufferSize(size);
      } else if (typeof renderer.getSize === "function") {
        renderer.getSize(size);
      }
      if (size.x > 0 && size.y > 0) {
        this.uniforms!.viewportSize.value.set(size.x, size.y);
      }
    });

    // Extract focal lengths from the camera's projection matrix
    // For a perspective camera:
    //   projectionMatrix[0] = 2n / (r-l)  ≈  2 * focalX / width
    //   projectionMatrix[5] = 2n / (t-b)  ≈  2 * focalY / height
    this.runProfileChunk("Camera projection", () => {
      const proj = camera.projectionMatrix.elements;
      const vpWidth = this.uniforms!.viewportSize.value.x;
      const vpHeight = this.uniforms!.viewportSize.value.y;
      focalX = (proj[0] * vpWidth) / 2;
      focalY = (proj[5] * vpHeight) / 2;
      isOrthographic = camera instanceof THREE.OrthographicCamera;
      cameraNear = sanitizeCameraNear((camera as THREE.Camera & { near?: number }).near ?? Number.NaN);
      this.uniforms!.focalX.value = focalX;
      this.uniforms!.focalY.value = focalY;
      this.uniforms!.cameraNear.value = cameraNear;
      this.uniforms!.isOrthographic.value = isOrthographic ? 1 : 0;
    });

    // Frustum cull chunks on CPU, then upload visibility to GPU
    let visibilityChanged = false;
    if (this.chunkData && this.chunkVisibilityArray && this.mesh && this.gpuSorter) {
      this.runProfileChunk("Chunk culling", () => {
        this.lastVisibleChunks = updateChunkVisibility(
          this.chunkData!,
          camera,
          this.mesh!.matrixWorld,
          this.chunkVisibilityArray!
        );
        const chunkPointCounts = this.chunkData!.chunkPointCounts;
        let visibleSplats = 0;
        for (let i = 0; i < this.chunkVisibilityArray!.length; i += 1) {
          if (this.chunkVisibilityArray![i] === 1) {
            visibleSplats += chunkPointCounts[i] ?? 0;
          }
        }
        this.lastChunkKeptSplats = visibleSplats;
      });

      // Upload visibility to GPU (sorter uses this for depth culling + triggers re-sort)
      this.runProfileChunk("Visibility upload", () => {
        visibilityChanged = this.gpuSorter!.updateChunkVisibility(this.chunkVisibilityArray!);

      // Workaround: Three.js Bindings._update() doesn't re-sync storage buffers
      // after initialization — it only handles uniform buffers, samplers, and
      // textures. Manually trigger the GPU upload via the backend's own
      // updateAttribute(), which calls device.queue.writeBuffer() internally.
      // This only uploads the small chunk visibility buffer (~1 KB), not sort data.
      const visAttr = this.buffers?.chunkVisibility;
      if (visAttr) {
        try {
          renderer.backend.updateAttribute(visAttr);
        } catch {
          // First frame or buffer not yet created — _init() will handle it
        }
      }
      });
    }

    // GPU depth sort (entirely on GPU — no CPU→GPU transfer needed for sort data)
    if (this.gpuSorter && this.mesh) {
      this.runProfileChunk("GPU sort dispatch", () => {
        this.lastSortStats = this.gpuSorter!.sort(renderer, camera, this.mesh!.matrixWorld);
      });
    }

    const projectionDirty =
      visibilityChanged ||
      (this.lastSortStats?.modelChange ?? "none") !== "none" ||
      hasCameraProjectionChanged(this.lastProjectionSnapshot, camera, this.uniforms.viewportSize.value);

    // GPU projection compute pre-pass: project Cov3D → Cov2D once per splat
    // (instead of 4× per vertex in the vertex shader)
    if (this.splatProjection && this.mesh && projectionDirty) {
      this.runProfileChunk("Projection compute dispatch", () => {
        this.splatProjection!.updateUniforms(
          camera,
          this.mesh!.matrixWorld,
          focalX,
          focalY,
          isOrthographic,
          cameraNear,
          this.currentSplatSizeScale,
          this.uniforms!.viewportSize.value
        );
        this.splatProjection!.dispatch(renderer);
      });
    }
    if (projectionDirty) {
      this.lastProjectionSnapshot = captureCameraProjectionSnapshot(camera, this.uniforms.viewportSize.value);
    }

    // Update per-frame status (throttled: every 10 frames or on sort mode change)
    this.statusFrameCounter++;
    const sortModeChanged = this.lastSortStats && this.lastSortStats.sortMode !== this.lastReportedSortMode;
    if (this.setActorStatusRef && this.lastSortStats && (sortModeChanged || this.statusFrameCounter >= 10)) {
      this.runProfileChunk("Status refresh", () => {
        this.statusFrameCounter = 0;
        this.lastReportedSortMode = this.lastSortStats!.sortMode;
        this.lastExactVisibleCenters = this.computeExactVisibleCenterCount(camera);
        this.setActorStatusRef!({
          values: {
            backend: "webgpu-tsl",
            loadState: "loaded",
            pointCount: this.pointCount,
            boundsMin: this.bounds?.min ?? "n/a",
            boundsMax: this.bounds?.max ?? "n/a",
            sortMethod: "gpu-bitonic-temporal",
            projectionPrepass: this.splatProjection !== null,
            cameraNear: Math.round(cameraNear * 10000) / 10000,
            chunkCount: this.chunkData?.chunks.length ?? 0,
            visibleChunks: this.lastVisibleChunks,
            chunkKeptSplats: this.lastChunkKeptSplats,
            chunkCulledSplats: Math.max(0, this.pointCount - this.lastChunkKeptSplats),
            chunkKeptRatio: this.pointCount > 0 ? Math.round((this.lastChunkKeptSplats / this.pointCount) * 1000) / 1000 : 0,
            exactVisibleCenters: this.lastExactVisibleCenters,
            exactVisibleRatio: this.pointCount > 0 ? Math.round((this.lastExactVisibleCenters / this.pointCount) * 1000) / 1000 : 0,
            cullingDebug: "chunk-local-obb",
            sortMode: this.lastSortStats!.sortMode,
            sortDispatches: this.lastSortStats!.dispatches,
            framesSinceFullSort: this.lastSortStats!.framesSinceFullSort,
            angleSinceSort: Math.round(this.lastSortStats!.angleSinceSort * 1000) / 1000
          },
          updatedAtIso: new Date().toISOString()
        });
      });
    }
  }

  private runProfileChunk<T>(label: string, run: () => T): T {
    if (this.profileChunkRef) {
      return this.profileChunkRef(label, run);
    }
    return run();
  }

  // ---------------------------------------------------------------------------
  // Uniform updates
  // ---------------------------------------------------------------------------

  private updateUniforms(
    opacity: number,
    brightness: number,
    scaleFactor: number,
    splatSizeScale: number,
    colorInputSpace: string
  ): void {
    if (!this.uniforms || !this.mesh) return;

    this.uniforms.opacity.value = Math.max(0, Math.min(1, opacity));
    this.uniforms.brightness.value = Math.max(0, brightness);
    this.uniforms.sizeScale.value = Math.max(0.01, splatSizeScale);
    const colorCode = this.parseColorInputSpaceCode(colorInputSpace);
    this.uniforms.colorInputSpace.value = colorCode;
    this.currentSplatSizeScale = Math.max(0.01, splatSizeScale);

    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    this.mesh.scale.setScalar(safeScale);
  }

  private parseColorInputSpaceCode(value: string): number {
    switch (value) {
      case "linear":
        return COLOR_SPACE_LINEAR;
      case "iphone-sdr":
        return COLOR_SPACE_IPHONE_SDR;
      case "apple-log":
        return COLOR_SPACE_APPLE_LOG;
      case "srgb":
      default:
        return COLOR_SPACE_SRGB;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private computeExactVisibleCenterCount(camera: THREE.Camera): number {
    if (!this.positionsData4 || !this.mesh || this.pointCount <= 0) {
      return 0;
    }

    const usesWebGpuDepth = camera.coordinateSystem === THREE.WebGPUCoordinateSystem;
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const worldPosition = new THREE.Vector3();
    const clipPosition = new THREE.Vector4();
    let visibleCount = 0;

    for (let index = 0; index < this.pointCount; index += 1) {
      const i4 = index * 4;
      worldPosition
        .set(this.positionsData4[i4] ?? 0, this.positionsData4[i4 + 1] ?? 0, this.positionsData4[i4 + 2] ?? 0)
        .applyMatrix4(this.mesh.matrixWorld);
      clipPosition.set(worldPosition.x, worldPosition.y, worldPosition.z, 1).applyMatrix4(viewProjection);
      if (clipPosition.w === 0) {
        continue;
      }
      const ndcX = clipPosition.x / clipPosition.w;
      const ndcY = clipPosition.y / clipPosition.w;
      const ndcZ = clipPosition.z / clipPosition.w;
      const visibleDepth = usesWebGpuDepth ? ndcZ >= 0 && ndcZ <= 1 : ndcZ >= -1 && ndcZ <= 1;
      if (ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && visibleDepth) {
        visibleCount += 1;
      }
    }

    return visibleCount;
  }

  private disposeRendering(): void {
    if (this.mesh) {
      this.mesh.onBeforeRender = () => {};
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      if (this.mesh.material instanceof THREE.Material) {
        this.mesh.material.dispose();
      }
      this.mesh = null;
    }
    this.buffers = null;
    this.uniforms = null;
    this.pointCount = 0;
    this.positionsData4 = null;
    this.bounds = null;
    this.chunkData = null;
    this.chunkVisibilityArray = null;
    this.lastVisibleChunks = 0;
    this.lastChunkKeptSplats = 0;
    this.lastExactVisibleCenters = 0;
    this.lastProjectionSnapshot = null;
    if (this.gpuSorter) {
      this.gpuSorter.dispose();
      this.gpuSorter = null;
    }
    if (this.splatProjection) {
      this.splatProjection.dispose();
      this.splatProjection = null;
    }
  }
}


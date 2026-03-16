/**
 * SplatController — orchestrates the load → parse → GPU upload → render lifecycle
 * for a single gaussian splat actor in the WebGPU plugin.
 *
 * Follows the same async load-token pattern as SparkSplatController to guard
 * against stale load completions when the user swaps assets rapidly.
 *
 * Phase 5: GPU bitonic sort + chunk-based frustum culling + NDC clip culling.
 */

import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import { tryParseSplatBinary } from "./splatBinaryFormat";
import { parsePlyGaussianData } from "./plyParser";
import { precomputeCovariances, computeBounds } from "./mathUtils";
import { createSplatMaterial, type SplatBuffers, type SplatUniforms } from "./splatMaterial";
import { GpuSorter } from "./splatGpuSort";
import { buildChunks, updateChunkVisibility, type ChunkData } from "./splatChunks";

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Convert a single sRGB channel value [0,1] to linear light [0,1]. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Context shape passed from syncObject (matches plugin SceneHookContext subset). */
interface SyncContext {
  actor: { id: string; params: Record<string, unknown> };
  object: unknown;
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

  // GPU sorting state
  private gpuSorter: GpuSorter | null = null;

  // Chunk-based frustum culling state
  private chunkData: ChunkData | null = null;
  private chunkVisibilityArray: Uint32Array | null = null;
  private lastVisibleChunks = 0;

  // One-shot diagnostics flag
  private hasLoggedDiagnostics = false;

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
    const splatSizeScale = typeof params.splatSizeScale === "number" ? params.splatSizeScale : 1;

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
      void this.loadAsset(assetId, context.readAssetBytes, context.setActorStatus);
    }

    // Update uniforms if mesh is live
    if (this.mesh && this.uniforms) {
      this.updateUniforms(opacity, brightness, scaleFactor, splatSizeScale);
    }
  }

  dispose(): void {
    this.disposeRendering();
    this.loadedAssetId = "";
    this.pendingAssetId = "";
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

      // Dispose any previous rendering
      this.disposeRendering();

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

      // Pack colors + per-splat opacity into vec4
      // PLY SH colors are in sRGB space (0.5 + SH_C0 * dc, clamped [0,1]).
      // The material outputs to colorNode which Three.js treats as linear,
      // and renderOutput() applies sRGB encoding. Convert sRGB→linear here
      // to avoid double-gamma encoding.
      const colorsData = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const i4 = i * 4;
        colorsData[i4] = srgbToLinear(data.colors[i3]);
        colorsData[i4 + 1] = srgbToLinear(data.colors[i3 + 1]);
        colorsData[i4 + 2] = srgbToLinear(data.colors[i3 + 2]);
        colorsData[i4 + 3] = data.opacities[i]; // opacity is linear
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

      // Create material + GPU sorter (wrapped in try-catch for cleaner error reporting
      // if shader compilation fails, e.g. when accidentally running under WebGL2)
      let material: THREE.Material;
      let uniforms: SplatUniforms;
      let gpuSorter: GpuSorter;
      try {
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

      // Store state before setting up onBeforeRender (needs references)
      this.mesh = mesh;
      this.buffers = buffers;
      this.uniforms = uniforms;
      this.pointCount = count;
      this.bounds = bounds;
      this.gpuSorter = gpuSorter;
      this.chunkData = chunkData;
      this.chunkVisibilityArray = visibilityArray;
      this.lastVisibleChunks = numChunks;
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
          sortMethod: "gpu-bitonic",
          chunkCount: numChunks
        },
        updatedAtIso: new Date().toISOString()
      });

      console.log(
        `[gsplat-webgpu] Loaded: ${count.toLocaleString()} splats, ` +
        `${numChunks} chunks, ` +
        `bounds: [${bounds.min.map(v => v.toFixed(2)).join(",")}] → [${bounds.max.map(v => v.toFixed(2)).join(",")}], ` +
        `color source: ${data.colorSource}`
      );

      // Diagnostic: log scale and covariance statistics for sizing investigation
      {
        const sampleCount = Math.min(count, 10);
        const scaleStats = { min: Infinity, max: -Infinity, sum: 0 };
        const covStats = { min: Infinity, max: -Infinity };
        for (let i = 0; i < count; i++) {
          const i3 = i * 3;
          const sx = data.scales[i3], sy = data.scales[i3 + 1], sz = data.scales[i3 + 2];
          const maxS = Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
          scaleStats.min = Math.min(scaleStats.min, maxS);
          scaleStats.max = Math.max(scaleStats.max, maxS);
          scaleStats.sum += maxS;
          const i6 = i * 6;
          const diagMax = Math.max(Math.abs(cov[i6]), Math.abs(cov[i6 + 3]), Math.abs(cov[i6 + 5]));
          covStats.min = Math.min(covStats.min, diagMax);
          covStats.max = Math.max(covStats.max, diagMax);
        }
        console.log(
          `[gsplat-webgpu] Scale stats: min=${scaleStats.min.toExponential(3)}, ` +
          `max=${scaleStats.max.toExponential(3)}, avg=${(scaleStats.sum / count).toExponential(3)}`
        );
        console.log(
          `[gsplat-webgpu] Cov3D diagonal stats: min=${covStats.min.toExponential(3)}, ` +
          `max=${covStats.max.toExponential(3)}`
        );
        // Sample first few splats
        const samples: string[] = [];
        for (let i = 0; i < sampleCount; i++) {
          const i3 = i * 3;
          const i6 = i * 6;
          samples.push(
            `  splat[${i}]: scale=(${data.scales[i3].toFixed(4)}, ${data.scales[i3+1].toFixed(4)}, ${data.scales[i3+2].toFixed(4)}) ` +
            `cov_diag=(${cov[i6].toExponential(3)}, ${cov[i6+3].toExponential(3)}, ${cov[i6+5].toExponential(3)}) ` +
            `opacity=${data.opacities[i].toFixed(3)}`
          );
        }
        console.log(`[gsplat-webgpu] Sample splats:\n${samples.join("\n")}`);
      }
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
    const size = new THREE.Vector2();
    if (typeof renderer.getDrawingBufferSize === "function") {
      renderer.getDrawingBufferSize(size);
    } else if (typeof renderer.getSize === "function") {
      renderer.getSize(size);
    }
    if (size.x > 0 && size.y > 0) {
      this.uniforms.viewportSize.value.set(size.x, size.y);
    }

    // Extract focal lengths from the camera's projection matrix
    // For a perspective camera:
    //   projectionMatrix[0] = 2n / (r-l)  ≈  2 * focalX / width
    //   projectionMatrix[5] = 2n / (t-b)  ≈  2 * focalY / height
    const proj = camera.projectionMatrix.elements;
    const vpWidth = this.uniforms.viewportSize.value.x;
    const vpHeight = this.uniforms.viewportSize.value.y;
    const focalX = (proj[0] * vpWidth) / 2;
    const focalY = (proj[5] * vpHeight) / 2;
    this.uniforms.focalX.value = focalX;
    this.uniforms.focalY.value = focalY;

    // One-shot diagnostic: log camera/viewport/focal data on first frame
    if (!this.hasLoggedDiagnostics) {
      this.hasLoggedDiagnostics = true;
      const backendName = renderer.backend?.constructor?.name ?? "unknown";
      const isWebGPUBackend = renderer.backend?.isWebGPUBackend === true;
      console.log(
        `[gsplat-webgpu] Camera diagnostics:\n` +
        `  viewport: ${vpWidth} × ${vpHeight}\n` +
        `  focalX: ${focalX.toFixed(2)}, focalY: ${focalY.toFixed(2)}\n` +
        `  proj[0]: ${proj[0].toFixed(4)}, proj[5]: ${proj[5].toFixed(4)}\n` +
        `  camera.position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})\n` +
        `  renderer type: ${renderer.constructor?.name || "unknown"}\n` +
        `  backend: ${backendName} (WebGPU: ${isWebGPUBackend})\n` +
        `  has compute: ${typeof renderer.compute === "function"}`
      );
      if (!isWebGPUBackend) {
        console.warn(
          `[gsplat-webgpu] WARNING: Renderer is NOT using WebGPU backend (got ${backendName}). ` +
          `GPU compute sort and storage buffers may not work correctly. ` +
          `Ensure the scene render engine is set to "webgpu".`
        );
      }
    }

    // Frustum cull chunks on CPU, then upload visibility to GPU
    if (this.chunkData && this.chunkVisibilityArray && this.mesh && this.gpuSorter) {
      this.lastVisibleChunks = updateChunkVisibility(
        this.chunkData,
        camera,
        this.mesh.matrixWorld,
        this.chunkVisibilityArray
      );

      // Upload visibility to GPU (sorter uses this for depth culling + triggers re-sort)
      this.gpuSorter.updateChunkVisibility(this.chunkVisibilityArray);

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
    }

    // GPU depth sort (entirely on GPU — no CPU→GPU transfer needed for sort data)
    if (this.gpuSorter && this.mesh) {
      this.gpuSorter.sort(renderer, camera, this.mesh.matrixWorld);
    }
  }

  // ---------------------------------------------------------------------------
  // Uniform updates
  // ---------------------------------------------------------------------------

  private updateUniforms(opacity: number, brightness: number, scaleFactor: number, splatSizeScale: number): void {
    if (!this.uniforms || !this.mesh) return;

    this.uniforms.opacity.value = Math.max(0, Math.min(1, opacity));
    this.uniforms.brightness.value = Math.max(0, brightness);
    this.uniforms.sizeScale.value = Math.max(0.01, splatSizeScale);

    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    this.mesh.scale.setScalar(safeScale);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

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
    this.bounds = null;
    this.chunkData = null;
    this.chunkVisibilityArray = null;
    this.lastVisibleChunks = 0;
    if (this.gpuSorter) {
      this.gpuSorter.dispose();
      this.gpuSorter = null;
    }
  }
}

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import { estimateSessionPayloadBytes } from "@/core/session/sessionSize";
import { SceneController } from "./sceneController";
import type { SplatOverlayActorState, SplatOverlayHandle } from "./splatOverlay";
import { DedicatedGaussianSplatOverlay, NoopSplatOverlay } from "./splatOverlay";
import { combineRenderStats, countActorStats, summarizeMemory, type RenderStatsSample } from "./stats";

const ENABLE_DEDICATED_SPLAT_OVERLAY = true;
const FAST_STATS_INTERVAL_MS = 500;
const SLOW_STATS_INTERVAL_MS = 2000;

export class WebGpuViewport {
  private readonly renderer: WebGPURenderer;
  private readonly perspectiveCamera: any;
  private readonly orthographicCamera: any;
  private activeCamera: any;
  private readonly controls: OrbitControls;
  private readonly sceneController: SceneController;
  private splatOverlay: SplatOverlayHandle;
  private frameHandle = 0;
  private frameCount = 0;
  private frameTimeAccumulatorMs = 0;
  private frameLastAt = performance.now();
  private fastStatsLastSampleAt = performance.now();
  private slowStatsLastSampleAt = performance.now();
  private lastAppliedCameraSignature = "";
  private lastSplatSignature = "";
  private readonly assetUrlCache = new Map<string, string>();
  private readonly blobAssetUrls = new Set<string>();
  private readonly geometryByteCache = new WeakMap<object, number>();
  private readonly textureByteCache = new WeakMap<object, number>();
  private dedicatedOverlayError: string | null = null;
  private splatSyncInFlight = false;
  private cachedSessionName = "";
  private started = false;
  private disposed = false;
  private initialized = false;
  private renderInFlight = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeObservedElements: HTMLElement[] = [];
  private readonly maxRenderDimension = 4096;
  private previousMainRenderSample: RenderStatsSample | null = null;
  private previousOverlayRenderSample: RenderStatsSample | null = null;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly mountEl: HTMLElement,
    overlay?: SplatOverlayHandle
  ) {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is required by this application.");
    }

    this.sceneController = new SceneController(kernel);
    this.renderer = new WebGPURenderer({ antialias: true, alpha: false });
    this.applyRenderScale(this.mountEl.clientWidth, this.mountEl.clientHeight);
    this.renderer.setSize(this.mountEl.clientWidth, this.mountEl.clientHeight);
    this.mountEl.appendChild(this.renderer.domElement);

    this.perspectiveCamera = new THREE.PerspectiveCamera(
      50,
      this.mountEl.clientWidth / this.mountEl.clientHeight,
      0.01,
      1000
    );
    this.perspectiveCamera.position.set(6, 4, 6);

    const aspect = this.mountEl.clientWidth / this.mountEl.clientHeight;
    const orthoSize = 8;
    this.orthographicCamera = new THREE.OrthographicCamera(
      -orthoSize * aspect,
      orthoSize * aspect,
      orthoSize,
      -orthoSize,
      0.01,
      1000
    );
    this.orthographicCamera.position.set(8, 8, 8);

    this.activeCamera = this.perspectiveCamera;
    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.splatOverlay = overlay ?? new NoopSplatOverlay();
    this.sceneController.setGaussianSplatFallbackEnabled(true);

    if (ENABLE_DEDICATED_SPLAT_OVERLAY && !overlay) {
      void this.bootstrapDedicatedSplatOverlay();
    }
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.disposed = false;
    if (typeof (this.renderer as any).init === "function") {
      await (this.renderer as any).init();
    }
    this.initialized = true;
    this.onResize();
    window.addEventListener("resize", this.onResize);
    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObservedElements = this.collectResizeObservedElements();
    for (const element of this.resizeObservedElements) {
      this.resizeObserver.observe(element);
    }
    this.animate();
  }

  public stop(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.resizeObservedElements = [];
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    this.controls.dispose();
    this.splatOverlay.dispose();
    this.revokeBlobAssetUrls();
    if (this.initialized) {
      try {
        this.renderer.dispose();
      } catch {
        // Renderer may already be torn down.
      }
    }
    if (this.mountEl.contains(this.renderer.domElement)) {
      this.mountEl.removeChild(this.renderer.domElement);
    }
  }

  private animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.frameHandle = requestAnimationFrame(this.animate);
    if (!this.initialized || this.renderInFlight) {
      return;
    }
    this.kernel.clock.tick(performance.now(), this.kernel.store);
    void this.sceneController.syncFromState();
    void this.syncSplatOverlay();
    this.syncCameraState();
    this.controls.update();
    this.syncCameraToState();
    this.renderInFlight = true;
    const renderPromise =
      typeof (this.renderer as any).renderAsync === "function"
        ? (this.renderer as any).renderAsync(this.sceneController.scene, this.activeCamera)
        : Promise.resolve((this.renderer as any).render(this.sceneController.scene, this.activeCamera));
    void Promise.resolve(renderPromise).finally(() => {
      this.renderInFlight = false;
    });
    this.splatOverlay.setCamera(this.activeCamera);
    this.splatOverlay.update();
    this.updateStats();
  };

  private async bootstrapDedicatedSplatOverlay(): Promise<void> {
    if (!("WebGL2RenderingContext" in window)) {
      return;
    }
    const overlay = new DedicatedGaussianSplatOverlay(this.mountEl, (message) => {
      this.kernel.store.getState().actions.setStatus(message);
    });
    try {
      await overlay.initialize();
      this.splatOverlay = overlay;
      this.sceneController.setGaussianSplatFallbackEnabled(false);
      this.dedicatedOverlayError = null;
      this.splatOverlay.setCamera(this.activeCamera);
      this.splatOverlay.setSize(this.mountEl.clientWidth, this.mountEl.clientHeight);
      this.kernel.store.getState().actions.setStatus("Dedicated Gaussian splat overlay enabled.");
    } catch (error) {
      this.splatOverlay = new NoopSplatOverlay();
      this.sceneController.setGaussianSplatFallbackEnabled(true);
      const reason = error instanceof Error ? error.message : "Unknown reason";
      this.dedicatedOverlayError = reason;
      this.kernel.store.getState().actions.addLog({
        level: "error",
        message: "Dedicated Gaussian splat overlay unavailable",
        details: reason
      });
      this.kernel.store
        .getState()
        .actions.setStatus(`Dedicated Gaussian splat overlay unavailable, fallback enabled. ${reason}`);
    }
  }

  private syncCameraState(): void {
    const cameraState = this.kernel.store.getState().state.camera;
    const signature = JSON.stringify(cameraState);
    this.activeCamera = cameraState.mode === "orthographic" ? this.orthographicCamera : this.perspectiveCamera;
    this.controls.object = this.activeCamera;
    if (signature !== this.lastAppliedCameraSignature) {
      if (this.activeCamera instanceof THREE.PerspectiveCamera) {
        this.activeCamera.fov = cameraState.fov;
        this.activeCamera.near = cameraState.near;
        this.activeCamera.far = cameraState.far;
        this.activeCamera.position.set(...cameraState.position);
        this.activeCamera.updateProjectionMatrix();
      } else {
        this.activeCamera.near = cameraState.near;
        this.activeCamera.far = cameraState.far;
        this.activeCamera.zoom = cameraState.zoom;
        this.activeCamera.position.set(...cameraState.position);
        this.activeCamera.updateProjectionMatrix();
      }
      this.controls.target.set(...cameraState.target);
      this.lastAppliedCameraSignature = signature;
    }
  }

  private onResize = (): void => {
    const { width, height } = this.getEffectiveViewportSize();
    this.mountEl.style.width = `${width}px`;
    this.mountEl.style.height = `${height}px`;
    this.applyRenderScale(width, height);
    this.renderer.setSize(width, height);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();

    const orthoSize = 8;
    const aspect = width / height;
    this.orthographicCamera.left = -orthoSize * aspect;
    this.orthographicCamera.right = orthoSize * aspect;
    this.orthographicCamera.top = orthoSize;
    this.orthographicCamera.bottom = -orthoSize;
    this.orthographicCamera.updateProjectionMatrix();
    this.splatOverlay.setSize(width, height);
  };

  private collectResizeObservedElements(): HTMLElement[] {
    const elements: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    let node: HTMLElement | null = this.mountEl;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (!seen.has(node)) {
        seen.add(node);
        elements.push(node);
      }
      if (
        node.classList.contains("flexlayout__tabset_content") ||
        node.classList.contains("flexlayout__tabset_container") ||
        node.classList.contains("flexlayout__layout")
      ) {
        break;
      }
      node = node.parentElement;
    }
    return elements;
  }

  private getEffectiveViewportSize(): { width: number; height: number } {
    const elements = this.resizeObservedElements.length > 0 ? this.resizeObservedElements : [this.mountEl];
    const measurementElements = elements.length > 1 ? elements.slice(1) : elements;
    let width = Number.POSITIVE_INFINITY;
    let height = Number.POSITIVE_INFINITY;
    for (const element of measurementElements) {
      width = Math.min(width, Math.max(1, Math.round(element.clientWidth)));
      height = Math.min(height, Math.max(1, Math.round(element.clientHeight)));
    }
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return {
        width: Math.max(1, Math.round(this.mountEl.clientWidth)),
        height: Math.max(1, Math.round(this.mountEl.clientHeight))
      };
    }
    return { width, height };
  }

  private applyRenderScale(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const dimensionLimit = Math.max(1, this.maxRenderDimension / Math.max(safeWidth, safeHeight));
    const pixelRatio = Math.max(0.5, Math.min(devicePixelRatio, dimensionLimit));
    this.renderer.setPixelRatio(pixelRatio);
  }

  private updateStats(): void {
    const now = performance.now();
    const frameDelta = Math.max(0, now - this.frameLastAt);
    this.frameLastAt = now;
    this.frameCount += 1;
    this.frameTimeAccumulatorMs += frameDelta;

    if (now - this.fastStatsLastSampleAt >= FAST_STATS_INTERVAL_MS && this.frameCount > 0) {
      const framesInWindow = this.frameCount;
      const elapsedMs = Math.max(1, now - this.fastStatsLastSampleAt);
      const fps = (framesInWindow * 1000) / elapsedMs;
      const frameMs = this.frameTimeAccumulatorMs / framesInWindow;
      this.frameCount = 0;
      this.frameTimeAccumulatorMs = 0;
      this.fastStatsLastSampleAt = now;

      const mainRenderStatsCumulative = this.readMainRenderStats();
      const overlayStats = this.splatOverlay.getStats();
      const overlayRenderStatsCumulative: RenderStatsSample = {
        drawCalls: overlayStats.drawCalls,
        triangles: overlayStats.triangles,
        points: overlayStats.points
      };
      const mainRenderStats = this.renderDeltaPerFrame(
        mainRenderStatsCumulative,
        this.previousMainRenderSample,
        framesInWindow
      );
      const overlayRenderStats = this.renderDeltaPerFrame(
        overlayRenderStatsCumulative,
        this.previousOverlayRenderSample,
        framesInWindow
      );
      this.previousMainRenderSample = mainRenderStatsCumulative;
      this.previousOverlayRenderSample = overlayRenderStatsCumulative;

      const combined = combineRenderStats(mainRenderStats, overlayRenderStats);
      const actorCounts = countActorStats(this.kernel.store.getState().state.actors);
      const currentStats = this.kernel.store.getState().state.stats;

      this.kernel.store.getState().actions.setStats({
        fps,
        frameMs,
        drawCalls: combined.drawCalls,
        drawCallsMain: combined.drawCallsMain,
        drawCallsOverlay: combined.drawCallsOverlay,
        triangles: combined.triangles,
        trianglesMain: combined.trianglesMain,
        trianglesOverlay: combined.trianglesOverlay,
        overlayPoints: combined.overlayPoints,
        actorCount: actorCounts.actorCount,
        actorCountEnabled: actorCounts.actorCountEnabled,
        sessionFileBytes: currentStats.sessionFileBytesSaved > 0 && !this.kernel.store.getState().state.dirty
          ? currentStats.sessionFileBytesSaved
          : currentStats.sessionFileBytes
      });
    }

    if (now - this.slowStatsLastSampleAt >= SLOW_STATS_INTERVAL_MS) {
      this.slowStatsLastSampleAt = now;
      const state = this.kernel.store.getState().state;
      const overlayStats = this.splatOverlay.getStats();
      const resourceBytes = this.estimateResourceBytes() + overlayStats.bufferBytes;
      const heapBytes = this.getHeapBytes();
      const memory = summarizeMemory(heapBytes, resourceBytes);
      const estimatedSessionBytes = state.dirty
        ? estimateSessionPayloadBytes(state, state.mode)
        : state.stats.sessionFileBytesSaved;
      this.kernel.store.getState().actions.setStats({
        memoryMb: memory.memoryMb,
        heapMb: memory.heapMb,
        resourceMb: memory.resourceMb,
        sessionFileBytes: estimatedSessionBytes
      });
    }
  }

  private readMainRenderStats(): RenderStatsSample {
    const info = this.renderer.info.render;
    return {
      drawCalls: Number(info.calls ?? 0),
      triangles: Number(info.triangles ?? 0),
      points: Number((info as { points?: number }).points ?? 0)
    };
  }

  private renderDeltaPerFrame(
    current: RenderStatsSample,
    previous: RenderStatsSample | null,
    framesInWindow: number
  ): RenderStatsSample {
    const safeFrames = Math.max(1, framesInWindow);
    const delta = (next: number, prev: number | null): number => {
      if (prev === null) {
        return next;
      }
      // Some render backends reset counters; treat negative jumps as reset events.
      return next >= prev ? next - prev : next;
    };
    return {
      drawCalls: delta(current.drawCalls, previous?.drawCalls ?? null) / safeFrames,
      triangles: delta(current.triangles, previous?.triangles ?? null) / safeFrames,
      points: delta(current.points, previous?.points ?? null) / safeFrames
    };
  }

  private getHeapBytes(): number | null {
    const perf = performance as Performance & {
      memory?: {
        usedJSHeapSize?: number;
      };
    };
    const used = perf.memory?.usedJSHeapSize;
    if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
      return null;
    }
    return used;
  }

  private estimateResourceBytes(): number {
    const scene = this.sceneController.scene as any;
    let total = 0;
    scene.traverse((node: any) => {
      const mesh = node as any;
      const geometry = mesh.geometry as any;
      if (geometry) {
        total += this.estimateGeometryBytes(geometry);
      }
      const material = mesh.material as any;
      if (!material) {
        return;
      }
      if (Array.isArray(material)) {
        for (const entry of material) {
          total += this.estimateMaterialTextureBytes(entry);
        }
        return;
      }
      total += this.estimateMaterialTextureBytes(material);
    });
    return total;
  }

  private estimateGeometryBytes(geometry: any): number {
    const cached = this.geometryByteCache.get(geometry);
    if (cached !== undefined) {
      return cached;
    }
    let total = 0;
    const attributes = geometry.attributes as Record<string, any>;
    for (const attribute of Object.values(attributes)) {
      const array = attribute.array as ArrayLike<number> & { BYTES_PER_ELEMENT?: number; length?: number };
      const length = typeof array.length === "number" ? array.length : 0;
      const bytesPerElement = typeof array.BYTES_PER_ELEMENT === "number" ? array.BYTES_PER_ELEMENT : 4;
      total += length * bytesPerElement;
    }
    const indexArray = geometry.index?.array as ArrayLike<number> & { BYTES_PER_ELEMENT?: number; length?: number } | undefined;
    if (indexArray) {
      const length = typeof indexArray.length === "number" ? indexArray.length : 0;
      const bytesPerElement = typeof indexArray.BYTES_PER_ELEMENT === "number" ? indexArray.BYTES_PER_ELEMENT : 4;
      total += length * bytesPerElement;
    }
    this.geometryByteCache.set(geometry, total);
    return total;
  }

  private estimateMaterialTextureBytes(material: any): number {
    let total = 0;
    for (const value of Object.values(material as Record<string, unknown>)) {
      if (value && typeof value === "object" && "isTexture" in value) {
        total += this.estimateTextureBytes(value as any);
      }
    }
    return total;
  }

  private estimateTextureBytes(texture: any): number {
    const cached = this.textureByteCache.get(texture);
    if (cached !== undefined) {
      return cached;
    }
    const image = texture.image as { width?: number; height?: number } | Array<{ width?: number; height?: number }> | undefined;
    let width = 0;
    let height = 0;
    if (Array.isArray(image)) {
      width = Math.max(...image.map((entry) => Number(entry.width ?? 0)), 0);
      height = Math.max(...image.map((entry) => Number(entry.height ?? 0)), 0);
    } else if (image) {
      width = Number(image.width ?? 0);
      height = Number(image.height ?? 0);
    }
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const safeHeight = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    // Approximate RGBA8 footprint, includes basic mip overhead factor.
    const bytes = safeWidth > 0 && safeHeight > 0 ? Math.floor(safeWidth * safeHeight * 4 * 1.33) : 0;
    this.textureByteCache.set(texture, bytes);
    return bytes;
  }

  private async syncSplatOverlay(): Promise<void> {
    if (this.splatSyncInFlight) {
      return;
    }

    const state = this.kernel.store.getState().state;
    if (state.activeSessionName !== this.cachedSessionName) {
      this.cachedSessionName = state.activeSessionName;
      this.revokeBlobAssetUrls();
      this.assetUrlCache.clear();
      this.lastSplatSignature = "";
    }
    const candidates = Object.values(state.actors)
      .filter((actor) => actor.actorType === "gaussian-splat" && actor.enabled)
      .map((actor) => {
        const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
        const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
        const scaleFactor = Number(actor.params.scaleFactor ?? 1);
        const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
        return {
          actorId: actor.id,
          assetId,
          reloadToken,
          opacity: Number(actor.params.opacity ?? 1),
          transform: {
            ...actor.transform,
            scale: [
              actor.transform.scale[0] * safeScaleFactor,
              actor.transform.scale[1] * safeScaleFactor,
              actor.transform.scale[2] * safeScaleFactor
            ] as [number, number, number]
          }
        };
      })
      .filter((actor) => actor.assetId.length > 0);

    const signature = JSON.stringify(candidates);
    if (!this.splatOverlay.isDedicatedRenderer && this.dedicatedOverlayError) {
      for (const candidate of candidates) {
        const existingStatus = state.actorStatusByActorId[candidate.actorId];
        this.kernel.store.getState().actions.setActorStatus(candidate.actorId, {
          values: {
            backend: "fallback-ply",
            loader: "three/examples/jsm/loaders/PLYLoader",
            loaderVersion: existingStatus?.values.loaderVersion ?? THREE.REVISION,
            assetFileName: existingStatus?.values.assetFileName,
            pointCount: existingStatus?.values.pointCount,
            boundsMin: existingStatus?.values.boundsMin as [number, number, number] | undefined,
            boundsMax: existingStatus?.values.boundsMax as [number, number, number] | undefined
          },
          error: `Dedicated overlay unavailable: ${this.dedicatedOverlayError}`,
          updatedAtIso: new Date().toISOString()
        });
      }
    }
    if (signature === this.lastSplatSignature) {
      return;
    }

    this.splatSyncInFlight = true;
    try {
      const actors: SplatOverlayActorState[] = [];
      for (const candidate of candidates) {
        let assetUrl = this.assetUrlCache.get(candidate.assetId);
        if (!assetUrl) {
          const asset = state.assets.find((entry) => entry.id === candidate.assetId);
          if (!asset) {
            continue;
          }
          assetUrl = await this.kernel.storage.resolveAssetPath({
            sessionName: state.activeSessionName,
            relativePath: asset.relativePath
          });
          this.assetUrlCache.set(candidate.assetId, assetUrl);
        }
        actors.push({
          actorId: candidate.actorId,
          assetId: candidate.assetId,
          assetUrl,
          opacity: candidate.opacity,
          transform: candidate.transform
        });
      }
      await this.splatOverlay.syncActors(actors);
      this.lastSplatSignature = signature;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.kernel.store.getState().actions.addLog({
        level: "error",
        message: "Dedicated Gaussian splat sync failed",
        details: reason
      });
      this.kernel.store.getState().actions.setStatus(`Dedicated Gaussian splat sync failed, fallback enabled. ${reason}`);
      this.dedicatedOverlayError = reason;
      if (this.splatOverlay.isDedicatedRenderer) {
        this.splatOverlay.dispose();
        this.splatOverlay = new NoopSplatOverlay();
        this.sceneController.setGaussianSplatFallbackEnabled(true);
      }
      this.lastSplatSignature = signature;
    } finally {
      this.splatSyncInFlight = false;
    }
  }

  private revokeBlobAssetUrls(): void {
    for (const blobUrl of this.blobAssetUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.blobAssetUrls.clear();
  }

  private syncCameraToState(): void {
    const camera = this.activeCamera;
    const target = this.controls.target;
    const cameraUpdate = {
      position: [camera.position.x, camera.position.y, camera.position.z] as [number, number, number],
      target: [target.x, target.y, target.z] as [number, number, number],
      zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : 1,
      fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : this.kernel.store.getState().state.camera.fov
    };
    const currentCamera = this.kernel.store.getState().state.camera;
    const moved =
      distanceSq3(cameraUpdate.position, currentCamera.position) > 1e-8 ||
      distanceSq3(cameraUpdate.target, currentCamera.target) > 1e-8 ||
      Math.abs(cameraUpdate.zoom - currentCamera.zoom) > 1e-6 ||
      Math.abs(cameraUpdate.fov - currentCamera.fov) > 1e-6;
    if (!moved) {
      return;
    }

    // Camera navigation should mark the session as stale so Save captures the current viewpoint.
    this.kernel.store.getState().actions.setCameraState(cameraUpdate, true);
    this.lastAppliedCameraSignature = JSON.stringify({
      ...currentCamera,
      ...cameraUpdate
    });
  }
}

function distanceSq3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

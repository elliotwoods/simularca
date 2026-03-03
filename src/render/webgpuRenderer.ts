import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import { estimateSessionPayloadBytes } from "@/core/session/sessionSize";
import { SceneController } from "./sceneController";
import { clearSplatQueryProvider, registerSplatQueryProvider } from "./splatQueryRegistry";
import { countActorStats, summarizeMemory, type RenderStatsSample } from "./stats";
import { CurveEditController } from "./curveEditController";

const FAST_STATS_INTERVAL_MS = 500;
const SLOW_STATS_INTERVAL_MS = 2000;

export class WebGpuViewport {
  private readonly renderer: WebGPURenderer;
  private readonly perspectiveCamera: any;
  private readonly orthographicCamera: any;
  private activeCamera: any;
  private readonly controls: OrbitControls;
  private readonly sceneController: SceneController;
  private readonly curveEditController: CurveEditController;
  private frameHandle = 0;
  private frameCount = 0;
  private frameTimeAccumulatorMs = 0;
  private frameLastAt = performance.now();
  private fastStatsLastSampleAt = performance.now();
  private slowStatsLastSampleAt = performance.now();
  private lastAppliedCameraSignature = "";
  private readonly geometryByteCache = new WeakMap<object, number>();
  private readonly textureByteCache = new WeakMap<object, number>();
  private readonly queryVisibleSplats = (args?: Parameters<SceneController["queryVisibleSplats"]>[0]) =>
    this.sceneController.queryVisibleSplats(args);
  private started = false;
  private disposed = false;
  private initialized = false;
  private renderInFlight = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeObservedElements: HTMLElement[] = [];
  private readonly maxRenderDimension = 4096;
  private previousMainRenderSample: RenderStatsSample | null = null;
  public constructor(private readonly kernel: AppKernel, private readonly mountEl: HTMLElement) {
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
    this.curveEditController = new CurveEditController(
      kernel,
      this.sceneController,
      this.controls,
      this.renderer.domElement,
      this.activeCamera
    );
    registerSplatQueryProvider(this.queryVisibleSplats);
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
    this.curveEditController.dispose();
    clearSplatQueryProvider(this.queryVisibleSplats);
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
    this.syncCameraState();
    this.curveEditController.setCamera(this.activeCamera);
    this.curveEditController.update();
    this.controls.update();
    this.sceneController.updateGaussianDepthSorting(this.activeCamera);
    this.syncCameraToState();
    this.renderInFlight = true;
    const renderPromise =
      typeof (this.renderer as any).renderAsync === "function"
        ? (this.renderer as any).renderAsync(this.sceneController.scene, this.activeCamera)
        : Promise.resolve((this.renderer as any).render(this.sceneController.scene, this.activeCamera));
    void Promise.resolve(renderPromise).finally(() => {
      this.renderInFlight = false;
    });
    this.updateStats();
  };

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
      const mainRenderStats = this.renderDeltaPerFrame(
        mainRenderStatsCumulative,
        this.previousMainRenderSample,
        framesInWindow
      );
      this.previousMainRenderSample = mainRenderStatsCumulative;
      const splatStats = this.sceneController.getGaussianRenderStats();
      const actorCounts = countActorStats(this.kernel.store.getState().state.actors);
      const currentStats = this.kernel.store.getState().state.stats;

      this.kernel.store.getState().actions.setStats({
        fps,
        frameMs,
        drawCalls: Math.max(0, Math.floor(mainRenderStats.drawCalls)),
        triangles: Math.max(0, Math.floor(mainRenderStats.triangles)),
        splatDrawCalls: splatStats.drawCalls,
        splatTriangles: splatStats.triangles,
        splatVisibleCount: splatStats.visibleCount,
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
      const resourceBytes = this.estimateResourceBytes();
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
      triangles: Number(info.triangles ?? 0)
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
      triangles: delta(current.triangles, previous?.triangles ?? null) / safeFrames
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

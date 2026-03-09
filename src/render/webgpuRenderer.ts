import * as THREE from "three";
import { PostProcessing, WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { pass } from "three/tsl";
import type { AppKernel } from "@/app/kernel";
import { estimateProjectPayloadBytes } from "@/core/project/projectSize";
import type { SceneFramePacingSettings } from "@/core/types";
import { ActorTransformController, type ActorTransformMode } from "./actorTransformController";
import { SceneController } from "./sceneController";
import { incompatibilityReason } from "./engineCompatibility";
import { FramePacer } from "./framePacing";
import { countActorStats, summarizeMemory, type RenderStatsSample } from "./stats";
import { CurveEditController } from "./curveEditController";
import { reportSlowFrame } from "./slowFrameDiagnostics";
import type { MistVolumeQualityMode } from "./mistVolumeController";
import { buildWebGpuToneMappedOutputNode, threeToneMappingForMode } from "./tonemapping";

const FAST_STATS_INTERVAL_MS = 500;
const SLOW_STATS_INTERVAL_MS = 2000;
const CAMERA_NAV_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class WebGpuViewport {
  private readonly renderer: WebGPURenderer;
  private readonly postProcessing: PostProcessing;
  private readonly scenePass: any;
  private readonly perspectiveCamera: any;
  private readonly orthographicCamera: any;
  private activeCamera: any;
  private readonly controls: OrbitControls;
  private readonly sceneController: SceneController;
  private readonly curveEditController: CurveEditController | null;
  private readonly actorTransformController: ActorTransformController | null;
  private frameHandle = 0;
  private frameCount = 0;
  private frameTimeAccumulatorMs = 0;
  private frameLastAt = performance.now();
  private fastStatsLastSampleAt = performance.now();
  private slowStatsLastSampleAt = performance.now();
  private lastAppliedCameraSignature = "";
  private readonly geometryByteCache = new WeakMap<object, number>();
  private readonly textureByteCache = new WeakMap<object, number>();
  private started = false;
  private disposed = false;
  private initialized = false;
  private renderInFlight = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeObservedElements: HTMLElement[] = [];
  private readonly maxRenderDimension = 4096;
  private readonly isExportViewport: boolean;
  private previousMainRenderSample: RenderStatsSample | null = null;
  private readonly wheelZoomSpeed = 0.12;
  private readonly navigationKeysDown = new Set<string>();
  private navigationLastAtMs = performance.now();
  private lastOutputSignature = "";
  private readonly framePacer: FramePacer;
  public constructor(
    private readonly kernel: AppKernel,
    private readonly mountEl: HTMLElement,
    options: { antialias: boolean; qualityMode?: MistVolumeQualityMode; showDebugHelpers?: boolean; editorOverlays?: boolean }
  ) {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is required by this application.");
    }

    this.isExportViewport = options.qualityMode === "export";
    this.sceneController = new SceneController(kernel, {
      qualityMode: options.qualityMode ?? "interactive",
      showDebugHelpers: options.showDebugHelpers ?? true
    });
    this.framePacer = new FramePacer(kernel.store.getState().state.scene.framePacing);
    this.renderer = new WebGPURenderer({ antialias: options.antialias, alpha: false });
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
    this.scenePass = pass(this.sceneController.scene, this.activeCamera);
    this.postProcessing = new PostProcessing(this.renderer, this.scenePass);
    this.postProcessing.outputColorTransform = false;
    this.syncToneMappingOutput();
    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    (this.controls as any).enableZoom = false;
    (this.controls as any).zoomSpeed = 1;
    (this.controls as any).minDistance = 0.01;
    (this.controls as any).maxDistance = 10000;
    (this.controls as any).minZoom = 0.05;
    (this.controls as any).maxZoom = 200;
    if (options.editorOverlays === false) {
      this.curveEditController = null;
      this.actorTransformController = null;
    } else {
      this.curveEditController = new CurveEditController(
        kernel,
        this.sceneController,
        this.controls,
        this.renderer.domElement,
        this.activeCamera
      );
      this.actorTransformController = new ActorTransformController(
        kernel,
        this.sceneController,
        this.controls,
        this.renderer.domElement,
        this.activeCamera
      );
    }
    window.addEventListener("wheel", this.onViewportWheel, { passive: false, capture: true });
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onWindowBlur);
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
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onWindowBlur);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.resizeObservedElements = [];
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    this.controls.dispose();
    window.removeEventListener("wheel", this.onViewportWheel, true);
    this.actorTransformController?.dispose();
    this.curveEditController?.dispose();
    this.sceneController.dispose();
    this.clearCompatibilityStatus();
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

  public setActorTransformMode(mode: ActorTransformMode): void {
    this.actorTransformController?.setMode(mode);
  }

  public setActorTransformSnappingEnabled(enabled: boolean): void {
    this.actorTransformController?.setSnappingEnabled(enabled);
  }

  public setFramePacing(settings: SceneFramePacingSettings): void {
    this.framePacer.setSettings(settings);
  }

  private animate = (nowMs = performance.now()): void => {
    if (this.disposed) {
      return;
    }
    this.frameHandle = requestAnimationFrame(this.animate);
    if (!this.initialized || this.renderInFlight) {
      return;
    }
    if (!this.framePacer.shouldRender(nowMs)) {
      return;
    }
    this.kernel.clock.tick(nowMs, this.kernel.store);
    this.renderInFlight = true;
    void this.renderFrame().finally(() => {
      this.renderInFlight = false;
    });
  };

  private async renderFrame(): Promise<void> {
    const _rf0 = performance.now();
    await this.sceneController.syncFromState();
    const _rf1 = performance.now();
    this.syncCameraState();
    this.applyKeyboardNavigation(performance.now());
    this.curveEditController?.setCamera(this.activeCamera);
    this.actorTransformController?.setCamera(this.activeCamera);
    this.curveEditController?.update();
    this.actorTransformController?.update();
    this.controls.update();
    this.enforceActorCompatibility("webgpu");
    this.syncCameraToState();
    this.syncToneMappingOutput();
    const _rf2 = performance.now();
    const renderPromise =
      typeof (this.postProcessing as any).renderAsync === "function"
        ? (this.postProcessing as any).renderAsync()
        : Promise.resolve((this.postProcessing as any).render());
    await Promise.resolve(renderPromise);
    const _rf3 = performance.now();
    reportSlowFrame(this.kernel, {
      backend: "webgpu",
      totalMs: _rf3 - _rf0,
      sceneSyncMs: _rf1 - _rf0,
      sparkSyncMs: 0,
      controlsMs: _rf2 - _rf1,
      renderMs: _rf3 - _rf2
    });
    this.updateStats();
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

  private enforceActorCompatibility(engine: "webgpu"): void {
    const state = this.kernel.store.getState().state;
    for (const actor of Object.values(state.actors)) {
      const reason = incompatibilityReason(actor, engine);
      const object = this.sceneController.getActorObject(actor.id);
      const current = state.actorStatusByActorId[actor.id];
      const currentValues = current?.values ?? {};
      const already = currentValues.renderIncompatible === true && currentValues.renderIncompatibleReason === reason;
      if (reason) {
        if (object) {
          object.visible = false;
        }
        if (already) {
          continue;
        }
        this.kernel.store.getState().actions.setActorStatus(actor.id, {
          values: {
            ...currentValues,
            renderIncompatible: true,
            renderIncompatibleEngine: engine,
            renderIncompatibleReason: reason
          },
          error: current?.error,
          updatedAtIso: new Date().toISOString()
        });
        continue;
      }
      if (currentValues.renderIncompatible !== true) {
        continue;
      }
      const nextValues = { ...currentValues };
      delete nextValues.renderIncompatible;
      delete nextValues.renderIncompatibleEngine;
      delete nextValues.renderIncompatibleReason;
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: nextValues,
        error: current?.error,
        updatedAtIso: new Date().toISOString()
      });
    }
  }

  private clearCompatibilityStatus(): void {
    const state = this.kernel.store.getState().state;
    for (const actor of Object.values(state.actors)) {
      const current = state.actorStatusByActorId[actor.id];
      if (!current) {
        continue;
      }
      const values = { ...current.values };
      delete values.renderIncompatible;
      delete values.renderIncompatibleEngine;
      delete values.renderIncompatibleReason;
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values,
        error: current.error,
        updatedAtIso: new Date().toISOString()
      });
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
    if (this.isExportViewport) {
      this.renderer.setPixelRatio(1);
      return;
    }
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
      const actorCounts = countActorStats(this.kernel.store.getState().state.actors);
      const currentStats = this.kernel.store.getState().state.stats;

      this.kernel.store.getState().actions.setStats({
        fps,
        frameMs,
        drawCalls: Math.max(0, Math.floor(mainRenderStats.drawCalls)),
        triangles: Math.max(0, Math.floor(mainRenderStats.triangles)),
        splatDrawCalls: 0,
        splatTriangles: 0,
        splatVisibleCount: 0,
        actorCount: actorCounts.actorCount,
        actorCountEnabled: actorCounts.actorCountEnabled,
        cameraDistance: this.activeCamera.position.distanceTo(this.controls.target),
        cameraControlsEnabled: Boolean((this.controls as any).enabled),
        cameraZoomEnabled: this.isWheelZoomEnabled(),
        projectFileBytes: currentStats.projectFileBytesSaved > 0 && !this.kernel.store.getState().state.dirty
          ? currentStats.projectFileBytesSaved
          : currentStats.projectFileBytes
      });
    }

    if (now - this.slowStatsLastSampleAt >= SLOW_STATS_INTERVAL_MS) {
      this.slowStatsLastSampleAt = now;
      const state = this.kernel.store.getState().state;
      const resourceBytes = this.estimateResourceBytes();
      const heapBytes = this.getHeapBytes();
      const memory = summarizeMemory(heapBytes, resourceBytes);
      const estimatedProjectBytes = state.dirty
        ? estimateProjectPayloadBytes(state, state.mode)
        : state.stats.projectFileBytesSaved;
      this.kernel.store.getState().actions.setStats({
        memoryMb: memory.memoryMb,
        heapMb: memory.heapMb,
        resourceMb: memory.resourceMb,
        projectFileBytes: estimatedProjectBytes
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

    // Camera navigation should mark the project as stale so Save captures the current viewpoint.
    this.kernel.store.getState().actions.setCameraState(cameraUpdate, true);
    this.lastAppliedCameraSignature = JSON.stringify({
      ...currentCamera,
      ...cameraUpdate
    });
  }

  private syncToneMappingOutput(): void {
    const tonemapping = this.kernel.store.getState().state.scene.tonemapping;
    const postProcessing = this.kernel.store.getState().state.scene.postProcessing;
    const signature = JSON.stringify({
      mode: tonemapping.mode,
      dither: tonemapping.dither,
      postProcessing,
      outputColorSpace: this.renderer.outputColorSpace
    });
    this.renderer.toneMapping = threeToneMappingForMode(tonemapping.mode);
    this.scenePass.camera = this.activeCamera;
    if (signature === this.lastOutputSignature) {
      return;
    }
    this.lastOutputSignature = signature;
    this.postProcessing.outputNode = buildWebGpuToneMappedOutputNode(
      this.scenePass.getTextureNode("output"),
      this.renderer.outputColorSpace,
      tonemapping,
      postProcessing
    );
    this.postProcessing.needsUpdate = true;
  }

  private onViewportWheel = (event: WheelEvent): void => {
    if (!this.isWheelEventInsideViewport(event)) {
      return;
    }
    const current = this.activeCamera;
    if (!current) {
      return;
    }
    const delta = Number.isFinite(event.deltaY) ? event.deltaY : 0;
    if (delta === 0) {
      return;
    }
    const direction = delta > 0 ? 1 : -1;
    const scalar = 1 + this.wheelZoomSpeed * Math.min(4, Math.abs(delta) / 100);
    this.cancelOrbitDecay();

    if (current instanceof THREE.OrthographicCamera) {
      const minZoom = Number((this.controls as any).minZoom ?? 0.05);
      const maxZoom = Number((this.controls as any).maxZoom ?? 200);
      const previousZoom = current.zoom;
      const nextZoom = direction > 0 ? current.zoom / scalar : current.zoom * scalar;
      current.zoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));

      // Fallback dolly compensation for render paths that don't honor orthographic zoom.
      const target = this.controls.target;
      const offset = new THREE.Vector3().copy(current.position).sub(target);
      const distance = offset.length();
      if (Number.isFinite(distance) && distance > 0 && previousZoom > 0 && current.zoom > 0) {
        const minDistance = Number((this.controls as any).minDistance ?? 0.01);
        const maxDistance = Number((this.controls as any).maxDistance ?? 10000);
        const nextDistance = distance * (previousZoom / current.zoom);
        const clampedDistance = Math.max(minDistance, Math.min(maxDistance, nextDistance));
        offset.setLength(clampedDistance);
        current.position.copy(target).add(offset);
      }

      current.updateProjectionMatrix();
      event.preventDefault();
      return;
    }

    if (current instanceof THREE.PerspectiveCamera) {
      const target = this.controls.target;
      const offset = new THREE.Vector3().copy(current.position).sub(target);
      const distance = offset.length();
      if (!Number.isFinite(distance) || distance <= 0) {
        return;
      }
      const minDistance = Number((this.controls as any).minDistance ?? 0.01);
      const maxDistance = Number((this.controls as any).maxDistance ?? 10000);
      const nextDistance = direction > 0 ? distance * scalar : distance / scalar;
      const clampedDistance = Math.max(minDistance, Math.min(maxDistance, nextDistance));
      offset.setLength(clampedDistance);
      current.position.copy(target).add(offset);
      event.preventDefault();
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (!CAMERA_NAV_KEYS.has(key)) {
      return;
    }
    this.navigationKeysDown.add(key);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (!CAMERA_NAV_KEYS.has(key)) {
      return;
    }
    this.navigationKeysDown.delete(key);
  };

  private onWindowBlur = (): void => {
    this.navigationKeysDown.clear();
  };

  private applyKeyboardNavigation(nowMs: number): void {
    const deltaSeconds = Math.max(0, Math.min(0.1, (nowMs - this.navigationLastAtMs) / 1000));
    this.navigationLastAtMs = nowMs;
    if (deltaSeconds <= 0) {
      return;
    }
    const scene = this.kernel.store.getState().state.scene;
    if (!scene.cameraKeyboardNavigation || this.navigationKeysDown.size === 0) {
      return;
    }
    const speed = Math.max(0, Number(scene.cameraNavigationSpeed ?? 0));
    if (speed <= 0 || !this.activeCamera) {
      return;
    }

    const forwardAxisRaw = Number(this.navigationKeysDown.has("w")) - Number(this.navigationKeysDown.has("s"));
    const forwardAxis = this.activeCamera instanceof THREE.OrthographicCamera ? 0 : forwardAxisRaw;
    const rightAxis = Number(this.navigationKeysDown.has("d")) - Number(this.navigationKeysDown.has("a"));
    const upAxis = Number(this.navigationKeysDown.has("e")) - Number(this.navigationKeysDown.has("q"));
    if (forwardAxis === 0 && rightAxis === 0 && upAxis === 0) {
      return;
    }

    this.cancelOrbitDecay();
    const forward = new THREE.Vector3();
    this.activeCamera.getWorldDirection(forward);
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 0, -1);
    } else {
      forward.normalize();
    }
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp);
    if (right.lengthSq() < 1e-8) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }

    const movement = new THREE.Vector3()
      .addScaledVector(forward, forwardAxis)
      .addScaledVector(right, rightAxis)
      .addScaledVector(worldUp, upAxis);
    if (movement.lengthSq() < 1e-8) {
      return;
    }
    movement.normalize().multiplyScalar(speed * deltaSeconds);
    this.activeCamera.position.add(movement);
    const target = this.controls.target as { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    target.set(target.x + movement.x, target.y + movement.y, target.z + movement.z);
  }

  private cancelOrbitDecay(): void {
    const controls = this.controls as any;
    controls._scale = 1;
    if (controls._sphericalDelta && typeof controls._sphericalDelta.set === "function") {
      controls._sphericalDelta.set(0, 0, 0);
    }
    if (controls._panOffset && typeof controls._panOffset.set === "function") {
      controls._panOffset.set(0, 0, 0);
    }
  }

  private isWheelEventInsideViewport(event: WheelEvent): boolean {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.length > 0) {
      for (const node of path) {
        if (node === this.mountEl || node === this.renderer.domElement) {
          return true;
        }
      }
      return false;
    }
    const target = event.target;
    return target instanceof Node ? this.mountEl.contains(target) : false;
  }

  private isWheelZoomEnabled(): boolean {
    return Boolean(this.activeCamera);
  }

}

function distanceSq3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

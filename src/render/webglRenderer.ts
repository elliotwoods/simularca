import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AppKernel } from "@/app/kernel";
import { estimateProjectPayloadBytes } from "@/core/project/projectSize";
import type { SceneFramePacingSettings } from "@/core/types";
import { ActorTransformController, type ActorTransformMode } from "@/render/actorTransformController";
import { CurveEditController } from "@/render/curveEditController";
import { CameraInteractionController } from "@/render/cameraInteractionController";
import { incompatibilityReason } from "@/render/engineCompatibility";
import { FramePacer } from "@/render/framePacing";
import { SceneController } from "@/render/sceneController";
import { reportSlowFrame } from "@/render/slowFrameDiagnostics";
import type { MistVolumeQualityMode } from "@/render/mistVolumeController";
import { SparkSplatController } from "@/render/sparkSplatController";
import { countActorStats, summarizeMemory, type RenderStatsSample } from "@/render/stats";
import { SceneOutputPass, threeToneMappingForMode } from "@/render/tonemapping";
import { captureViewportScreenshotFromCanvas, type ViewportScreenshotResult } from "@/features/render/viewportScreenshot";

const FAST_STATS_INTERVAL_MS = 500;
const SLOW_STATS_INTERVAL_MS = 2000;

export class WebGlViewport {
  private readonly renderer: any;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly sceneOutputPass: SceneOutputPass;
  private readonly perspectiveCamera: any;
  private readonly orthographicCamera: any;
  private activeCamera: any;
  private readonly controls: OrbitControls;
  private readonly cameraController: CameraInteractionController;
  private readonly sceneController: SceneController;
  private readonly curveEditController: CurveEditController | null;
  private readonly actorTransformController: ActorTransformController | null;
  private readonly sparkSplatController: SparkSplatController;
  private frameHandle = 0;
  private frameCount = 0;
  private frameTimeAccumulatorMs = 0;
  private frameLastAt = performance.now();
  private fastStatsLastSampleAt = performance.now();
  private slowStatsLastSampleAt = performance.now();
  private lastAppliedCameraSignature = "";
  private lastDispatchedCameraSignature = "";
  private readonly geometryByteCache = new WeakMap<object, number>();
  private readonly textureByteCache = new WeakMap<object, number>();
  private started = false;
  private disposed = false;
  private renderInFlight = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeObservedElements: HTMLElement[] = [];
  private readonly maxRenderDimension = 4096;
  private readonly isExportViewport: boolean;
  private readonly fixedViewportSize: { width: number; height: number } | null;
  private previousMainRenderSample: RenderStatsSample | null = null;
  private readonly framePacer: FramePacer;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly mountEl: HTMLElement,
    options: {
      antialias: boolean;
      qualityMode?: MistVolumeQualityMode;
      showDebugHelpers?: boolean;
      editorOverlays?: boolean;
      viewportSize?: { width: number; height: number };
    }
  ) {
    this.isExportViewport = options.qualityMode === "export";
    this.fixedViewportSize = options.viewportSize
      ? {
          width: Math.max(1, Math.round(options.viewportSize.width)),
          height: Math.max(1, Math.round(options.viewportSize.height))
        }
      : null;
    this.sceneController = new SceneController(kernel, {
      qualityMode: options.qualityMode ?? "interactive",
      showDebugHelpers: options.showDebugHelpers ?? true
    });
    this.sparkSplatController = new SparkSplatController(kernel, this.sceneController);
    this.framePacer = new FramePacer(kernel.store.getState().state.scene.framePacing);
    this.renderer = new THREE.WebGLRenderer({ antialias: options.antialias, alpha: false });
    this.sceneController.setWebGlRenderer(this.renderer);
    const initialWidth = this.fixedViewportSize?.width ?? Math.max(1, this.mountEl.clientWidth);
    const initialHeight = this.fixedViewportSize?.height ?? Math.max(1, this.mountEl.clientHeight);
    this.applyRenderScale(initialWidth, initialHeight);
    this.renderer.setSize(initialWidth, initialHeight);
    this.mountEl.appendChild(this.renderer.domElement);

    this.perspectiveCamera = new THREE.PerspectiveCamera(
      50,
      initialWidth / initialHeight,
      0.01,
      1000
    );
    this.perspectiveCamera.position.set(6, 4, 6);

    const aspect = initialWidth / initialHeight;
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
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.sceneController.scene, this.activeCamera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(initialWidth, initialHeight),
      0.6,
      0.2,
      0.85
    );
    this.sceneOutputPass = new SceneOutputPass();
    this.sceneOutputPass.renderToScreen = true;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.sceneOutputPass);
    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    (this.controls as any).enableZoom = false;
    (this.controls as any).zoomSpeed = 1;
    (this.controls as any).minDistance = 0.01;
    (this.controls as any).maxDistance = 10000;
    (this.controls as any).minZoom = 0.05;
    (this.controls as any).maxZoom = 200;
    this.controls.disconnect?.();
    this.renderer.domElement.style.touchAction = "none";
    this.cameraController = new CameraInteractionController({
      kernel,
      domElement: this.renderer.domElement,
      controls: this.controls,
      getCamera: () => this.activeCamera
    });
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
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.disposed = false;
    this.onResize();
    if (!this.fixedViewportSize) {
      window.addEventListener("resize", this.onResize);
      this.resizeObserver = new ResizeObserver(() => {
        this.onResize();
      });
      this.resizeObservedElements = this.collectResizeObservedElements();
      for (const element of this.resizeObservedElements) {
        this.resizeObserver.observe(element);
      }
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
    this.cameraController.dispose();
    this.controls.dispose();
    this.actorTransformController?.dispose();
    this.curveEditController?.dispose();
    this.sparkSplatController.dispose();
    this.sceneController.setWebGlRenderer(null);
    this.sceneController.dispose();
    this.bloomPass.dispose();
    this.sceneOutputPass.dispose();
    this.clearNativeGaussianConflictStatus();
    this.renderer.dispose();
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

  public async renderOnce(): Promise<void> {
    if (this.disposed) {
      throw new Error("Viewport has been disposed.");
    }
    this.onResize();
    await this.renderFrame({ collectStats: false });
  }

  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  public async captureViewportScreenshot(requestSize: { width: number; height: number }): Promise<ViewportScreenshotResult> {
    if (this.disposed) {
      throw new Error("Viewport has been disposed.");
    }
    void requestSize;
    while (this.renderInFlight) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
    const previousDebugHelpersVisible = this.sceneController.getDebugHelpersVisible();
    try {
      this.sceneController.setDebugHelpersVisible(false);
      for (let passIndex = 0; passIndex < 2; passIndex += 1) {
        await this.renderOnce();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      return await captureViewportScreenshotFromCanvas({
        backend: "webgl2",
        canvas: this.renderer.domElement
      });
    } finally {
      this.sceneController.setDebugHelpersVisible(previousDebugHelpersVisible);
    }
  }

  private animate = (nowMs = performance.now()): void => {
    if (this.disposed) {
      return;
    }
    this.frameHandle = requestAnimationFrame(this.animate);
    if (this.renderInFlight) {
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

  private async renderFrame(options?: { collectStats?: boolean }): Promise<void> {
    const collectStats = options?.collectStats ?? true;
    const _rf0 = performance.now();
    await this.sceneController.syncFromState();
    const _rf1 = performance.now();
    await this.sparkSplatController.syncFromState();
    const _rf2 = performance.now();
    this.enforceActorCompatibility("webgl2");
    this.syncCameraState();
    this.cameraController.update(performance.now());
    this.curveEditController?.setCamera(this.activeCamera);
    this.actorTransformController?.setCamera(this.activeCamera);
    this.curveEditController?.update();
    this.actorTransformController?.update();
    this.controls.update();
    this.syncCameraToState();
    const _rf3 = performance.now();
    const tonemapping = this.kernel.store.getState().state.scene.tonemapping;
    const postProcessing = this.kernel.store.getState().state.scene.postProcessing;
    this.renderer.toneMapping = threeToneMappingForMode(tonemapping.mode);
    this.renderPass.camera = this.activeCamera;
    this.bloomPass.enabled = postProcessing.bloom.enabled;
    this.bloomPass.strength = postProcessing.bloom.strength;
    this.bloomPass.radius = postProcessing.bloom.radius;
    this.bloomPass.threshold = postProcessing.bloom.threshold;
    this.sceneOutputPass.setDitherEnabled(tonemapping.dither);
    this.sceneOutputPass.setPostProcessingSettings(postProcessing);
    this.composer.render();
    const _rf4 = performance.now();
    if (collectStats) {
      reportSlowFrame(this.kernel, {
        backend: "webgl2",
        totalMs: _rf4 - _rf0,
        sceneSyncMs: _rf1 - _rf0,
        sparkSyncMs: _rf2 - _rf1,
        controlsMs: _rf3 - _rf2,
        renderMs: _rf4 - _rf3
      });
      this.updateStats();
    }
  }

  private enforceActorCompatibility(engine: "webgl2"): void {
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

  private clearNativeGaussianConflictStatus(): void {
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

  private syncCameraToState(): void {
    const nextCameraState = {
      mode: (this.activeCamera === this.orthographicCamera ? "orthographic" : "perspective") as
        | "orthographic"
        | "perspective",
      position: [this.activeCamera.position.x, this.activeCamera.position.y, this.activeCamera.position.z] as [
        number,
        number,
        number
      ],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z] as [number, number, number],
      fov:
        this.activeCamera instanceof THREE.PerspectiveCamera
          ? this.activeCamera.fov
          : this.kernel.store.getState().state.camera.fov,
      zoom:
        this.activeCamera instanceof THREE.OrthographicCamera
          ? this.activeCamera.zoom
          : this.kernel.store.getState().state.camera.zoom,
      near: this.activeCamera.near,
      far: this.activeCamera.far
    };

    const sig = JSON.stringify(nextCameraState);
    if (sig === this.lastDispatchedCameraSignature) return;
    this.lastDispatchedCameraSignature = sig;
    this.kernel.store.getState().actions.setCameraState(nextCameraState, false);
  }

  private onResize = (): void => {
    const { width, height } = this.getEffectiveViewportSize();
    this.mountEl.style.width = `${width}px`;
    this.mountEl.style.height = `${height}px`;
    this.applyRenderScale(width, height);
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
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
    if (this.fixedViewportSize) {
      return this.fixedViewportSize;
    }
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
      const splatStats = this.sparkSplatController.getRenderStats();
      const actorCounts = countActorStats(this.kernel.store.getState().state.actors);
      const currentStats = this.kernel.store.getState().state.stats;

      this.kernel.store.getState().actions.setStats({
        fps,
        frameMs,
        drawCalls: Math.max(0, Math.floor(mainRenderStats.drawCalls)),
        triangles: Math.max(0, Math.floor(mainRenderStats.triangles)),
        splatDrawCalls: splatStats.drawCalls,
        splatTriangles: 0,
        splatVisibleCount: splatStats.visibleCount,
        actorCount: actorCounts.actorCount,
        actorCountEnabled: actorCounts.actorCountEnabled,
        cameraDistance: this.activeCamera.position.distanceTo(this.controls.target),
        cameraControlsEnabled: Boolean((this.controls as any).enabled),
        cameraZoomEnabled: this.isWheelZoomEnabled(),
        projectFileBytes:
          currentStats.projectFileBytesSaved > 0 && !this.kernel.store.getState().state.dirty
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

  private isWheelZoomEnabled(): boolean {
    return Boolean(this.activeCamera);
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
      return next >= prev ? next - prev : next;
    };
    return {
      drawCalls: delta(current.drawCalls, previous?.drawCalls ?? null) / safeFrames,
      triangles: delta(current.triangles, previous?.triangles ?? null) / safeFrames
    };
  }

  private getHeapBytes(): number | null {
    const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    const used = perf.memory?.usedJSHeapSize;
    if (typeof used !== "number") {
      return null;
    }
    return used;
  }

  private estimateResourceBytes(): number {
    let geometryBytes = 0;
    let textureBytes = 0;
    const seenGeometries = new Set<any>();
    const seenTextures = new Set<any>();
    this.sceneController.scene.traverse((object: any) => {
      const geometry = object.geometry;
      if (geometry && !seenGeometries.has(geometry)) {
        seenGeometries.add(geometry);
        geometryBytes += this.estimateGeometryBytes(geometry);
      }

      const material = object.material;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const entry of materials) {
        if (!entry) {
          continue;
        }
        for (const value of Object.values(entry)) {
          if (value instanceof THREE.Texture && !seenTextures.has(value)) {
            seenTextures.add(value);
            textureBytes += this.estimateTextureBytes(value);
          }
        }
      }
    });

    return geometryBytes + textureBytes;
  }

  private estimateGeometryBytes(geometry: any): number {
    const cached = this.geometryByteCache.get(geometry);
    if (cached !== undefined) {
      return cached;
    }
    let bytes = 0;
    const attributes = geometry.attributes as Record<string, any>;
    if (attributes) {
      for (const attribute of Object.values(attributes)) {
        const array = attribute?.array as ArrayBufferView | undefined;
        if (array) {
          bytes += array.byteLength;
        }
      }
    }
    const indexArray = geometry.index?.array as ArrayBufferView | undefined;
    if (indexArray) {
      bytes += indexArray.byteLength;
    }
    this.geometryByteCache.set(geometry, bytes);
    return bytes;
  }

  private estimateTextureBytes(texture: any): number {
    const cached = this.textureByteCache.get(texture);
    if (cached !== undefined) {
      return cached;
    }
    let bytes = 0;
    const image = texture.image as
      | { width?: number; height?: number; data?: ArrayBufferView }
      | Array<{ width?: number; height?: number; data?: ArrayBufferView }>
      | undefined;
    const images = Array.isArray(image) ? image : image ? [image] : [];
    for (const entry of images) {
      if (entry.data) {
        bytes += entry.data.byteLength;
        continue;
      }
      const width = Number(entry.width ?? 0);
      const height = Number(entry.height ?? 0);
      if (width > 0 && height > 0) {
        bytes += width * height * 4;
      }
    }
    this.textureByteCache.set(texture, bytes);
    return bytes;
  }
}

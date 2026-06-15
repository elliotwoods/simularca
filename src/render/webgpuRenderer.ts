import * as THREE from "three";
import { PostProcessing, WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as TSL from "three/tsl";
import { pass } from "three/tsl";
import { AO_MESH_LAYER } from "./aoLayer";
const mrt = (TSL as any).mrt as (outputs: Record<string, any>) => any;
const normalView = (TSL as any).normalView as any;
const tslOutput = (TSL as any).output as any;
import type { AppKernel } from "@/app/kernel";
import { estimateProjectPayloadBytes } from "@/core/project/projectSize";
import type { CameraState, SceneColorBufferPrecision, SceneFramePacingSettings } from "@/core/types";
import { ActorTransformController, type ActorTransformMode } from "./actorTransformController";
import { CameraInteractionController } from "./cameraInteractionController";
import { cameraStatesApproximatelyEqual, cloneCameraState, readViewportCameraState } from "./cameraSync";
import { SceneController } from "./sceneController";
import { incompatibilityReason } from "./engineCompatibility";
import { FramePacer } from "./framePacing";
import {
  getWebGpuColorBufferSupport,
  resolveSceneColorBufferPrecision,
  type ResolvedSceneColorBufferPrecision
} from "./colorBufferPrecision";
import { countActorStats, summarizeMemory, type RenderStatsSample } from "./stats";
import { CurveEditController } from "./curveEditController";
import { DimensionOverlayController } from "./dimensionOverlayController";
import { SceneGridController } from "./sceneGridController";
import { reportSlowFrame } from "./slowFrameDiagnostics";
import { bumpFrameCounter, setViewportStatsProvider } from "@/app/runtimeStats";

// This module owns long-lived Three.js GPU resources and DOM event listeners.
// In-place HMR leaves stale instances whose class-field arrows can be replaced
// out from under live event listeners (observed: "this.scheduleResize is not
// a function" firing every frame for hours). Force a full page reload instead.
if (import.meta.hot) {
  // Vite 6 removed hot.decline(); self-accept then immediately invalidate so
  // the update propagates to importers and ends in a full page reload.
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate();
  });
}
import type { MistVolumeQualityMode } from "./mistVolumeController";
import { buildWebGpuToneMappedOutputNode, threeToneMappingForMode } from "./tonemapping";
import { configureCanvasForHdr, isHdrOutputSupported } from "./hdrSupport";
import {
  HDR_HISTOGRAM_BINS,
  HDR_HISTOGRAM_MAX,
  isHdrHistogramEnabled,
  publishHdrHistogram
} from "@/features/render/hdrHistogramBridge";
import { pruneInvalidSceneGraph } from "./sceneGraphUtils";
import {
  captureViewportScreenshotFromCanvas,
  captureViewportThumbnail,
  type ViewportScreenshotResult,
  type ViewportThumbnailResult
} from "@/features/render/viewportScreenshot";
import type { ProfileFrameGpuInput } from "./profiling";

const FAST_STATS_INTERVAL_MS = 500;
const SLOW_STATS_INTERVAL_MS = 2000;

// HDR histogram readback tuning.
const HISTOGRAM_SAMPLE_INTERVAL_MS = 120; // ~8 Hz
const HISTOGRAM_MAX_SAMPLES = 50_000; // stride-sample cap to bound CPU work

function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let val: number;
  if (exp === 0) {
    val = (frac / 1024) * Math.pow(2, -14);
  } else if (exp === 0x1f) {
    val = frac ? Number.NaN : Number.POSITIVE_INFINITY;
  } else {
    val = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return sign ? -val : val;
}

// Inverse of the sRGB OETF (the canvas stores OETF-encoded values), extended
// monotonically for encoded values > 1 so HDR highlights decode to linear > 1.
function srgbEotf(e: number): number {
  const a = Math.abs(e);
  const lin = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return e < 0 ? -lin : lin;
}

export class WebGpuViewport {
  private readonly renderer: WebGPURenderer;
  private readonly postProcessing: PostProcessing;
  private readonly scenePass: any;
  private readonly aoMeshPass: any;
  private readonly aoPerspectiveCamera: THREE.PerspectiveCamera;
  private readonly aoOrthographicCamera: THREE.OrthographicCamera;
  private aoCamera: THREE.Camera;
  private readonly perspectiveCamera: any;
  private readonly orthographicCamera: any;
  private activeCamera: any;
  private readonly controls: OrbitControls;
  private readonly cameraController: CameraInteractionController;
  private readonly sceneController: SceneController;
  private readonly curveEditController: CurveEditController | null;
  private readonly dimensionOverlayController: DimensionOverlayController | null;
  private readonly sceneGridController: SceneGridController;
  private readonly actorTransformController: ActorTransformController | null;
  private frameHandle = 0;
  private frameCount = 0;
  private frameTimeAccumulatorMs = 0;
  private frameLastAt = performance.now();
  private fastStatsLastSampleAt = performance.now();
  private slowStatsLastSampleAt = performance.now();
  private lastAppliedCameraState: CameraState | null = null;
  private readonly geometryByteCache = new WeakMap<object, number>();
  private readonly textureByteCache = new WeakMap<object, number>();
  private started = false;
  private disposed = false;
  private initialized = false;
  private renderInFlight = false;
  private activeRenderPromise: Promise<void> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeObservedElements: HTMLElement[] = [];
  private resizeRafHandle = 0;
  private lastAppliedSize: { width: number; height: number; pixelRatio: number } | null = null;
  private readonly maxRenderDimension = 4096;
  private readonly isExportViewport: boolean;
  private readonly manualFrameControl: boolean;
  private readonly fixedViewportSize: { width: number; height: number } | null;
  private previousMainRenderSample: RenderStatsSample | null = null;
  private lastOutputSignature = "";
  private readonly framePacer: FramePacer;
  private readonly colorBufferPrecision: ResolvedSceneColorBufferPrecision;
  private lastLoggedColorBufferWarning: string | null = null;
  private readonly hdrOutput: boolean;
  private hdrConfigured = false;
  // Live viewport luminance histogram readback (HDR Preview panel). Sampling only runs
  // while a subscriber is registered on the bridge; throttled + guarded so it never
  // stalls the frame.
  private histogramBusy = false;
  private histogramLastSampleMs = 0;
  private histogramStagingBuffer: GPUBuffer | null = null;
  private histogramStagingSize = 0;
  public constructor(
    private readonly kernel: AppKernel,
    private readonly mountEl: HTMLElement,
    options: {
      antialias: boolean;
      qualityMode?: MistVolumeQualityMode;
      showDebugHelpers?: boolean;
      editorOverlays?: boolean;
      viewportSize?: { width: number; height: number };
      manualFrameControl?: boolean;
      colorBufferPrecision?: SceneColorBufferPrecision;
      hdrOutput?: boolean;
    }
  ) {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is required by this application.");
    }

    this.isExportViewport = options.qualityMode === "export";
    this.manualFrameControl = options.manualFrameControl === true;
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
    this.framePacer = new FramePacer(kernel.store.getState().state.scene.framePacing);
    this.colorBufferPrecision = resolveSceneColorBufferPrecision(
      options.colorBufferPrecision ?? kernel.store.getState().state.scene.colorBufferPrecision,
      getWebGpuColorBufferSupport(),
      "webgpu",
      {
        requestedAntialiasing: options.antialias
      }
    );
    // HDR is for the live display only. Export viewports render to 8-bit SDR
    // images/video, where an HDR float / Display-P3 canvas would shift exported colors.
    this.hdrOutput =
      !this.isExportViewport &&
      (options.hdrOutput ?? kernel.store.getState().state.scene.hdrOutput) &&
      isHdrOutputSupported();
    this.renderer = new WebGPURenderer({
      antialias: this.colorBufferPrecision.activeAntialiasing,
      alpha: false,
      colorBufferType: this.colorBufferPrecision.bufferType,
      trackTimestamp: true
    });
    this.sceneController.setRenderer(this.renderer as unknown as any);
    const initialWidth = this.fixedViewportSize?.width ?? Math.max(1, this.mountEl.clientWidth);
    const initialHeight = this.fixedViewportSize?.height ?? Math.max(1, this.mountEl.clientHeight);
    this.renderer.setPixelRatio(this.computeRenderScale(initialWidth, initialHeight));
    this.renderer.setSize(initialWidth, initialHeight);
    // Prevent the browser from interpreting touch drags on the canvas as
    // page scroll/zoom — otherwise pointermove events for orbit never fire
    // on mobile.
    this.renderer.domElement.style.touchAction = "none";
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
    this.scenePass = pass(this.sceneController.scene, this.activeCamera);

    this.aoPerspectiveCamera = this.perspectiveCamera.clone();
    this.aoPerspectiveCamera.layers.set(AO_MESH_LAYER);
    this.aoOrthographicCamera = this.orthographicCamera.clone();
    this.aoOrthographicCamera.layers.set(AO_MESH_LAYER);
    this.aoCamera = this.aoPerspectiveCamera;
    this.aoMeshPass = pass(this.sceneController.scene, this.aoCamera);
    this.aoMeshPass.setMRT(mrt({ output: tslOutput, normal: normalView }));

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
    this.controls.disconnect?.();
    this.cameraController = new CameraInteractionController({
      kernel,
      domElement: this.renderer.domElement,
      controls: this.controls,
      getCamera: () => this.activeCamera
    });
    if (options.editorOverlays === false) {
      this.curveEditController = null;
      this.actorTransformController = null;
      this.dimensionOverlayController = null;
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
      this.dimensionOverlayController = new DimensionOverlayController(
        kernel,
        this.sceneController,
        this.controls,
        this.renderer.domElement,
        this.activeCamera
      );
    }
    this.sceneGridController = new SceneGridController(kernel, this.sceneController, this.activeCamera);
    this.cameraController.setPointerDownBlocker(
      (event) =>
        (this.curveEditController?.willHandlePointerDown(event) ?? false) ||
        (this.actorTransformController?.willHandlePointerDown(event) ?? false) ||
        (this.dimensionOverlayController?.willHandlePointerDown(event) ?? false)
    );
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
    this.applyHdrConfiguration();
    this.setGpuTimestampTracking(false);
    this.onResize();
    if (!this.fixedViewportSize) {
      window.addEventListener("resize", this.handleResizeEvent);
      this.resizeObserver = new ResizeObserver(this.handleResizeEvent);
      this.resizeObservedElements = this.collectResizeObservedElements();
      for (const element of this.resizeObservedElements) {
        this.resizeObserver.observe(element);
      }
    }
    if (!this.manualFrameControl) {
      this.animate();
    }
    setViewportStatsProvider(() => {
      if (this.disposed) {
        return null;
      }
      // WebGPURenderer.info exposes memory + render.frame at runtime, but the
      // Three.js typings only declare render.{calls,triangles}.
      const info = this.renderer.info as unknown as {
        memory?: { geometries?: number; textures?: number };
        render?: { triangles?: number; calls?: number; frame?: number };
      };
      const memInfo = info?.memory;
      const renderInfo = info?.render;
      return {
        geometries: memInfo?.geometries ?? 0,
        textures: memInfo?.textures ?? 0,
        triangles: renderInfo?.triangles ?? 0,
        calls: renderInfo?.calls ?? 0,
        frame: renderInfo?.frame ?? 0
      };
    });
  }

  public async stop(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    setViewportStatsProvider(null);
    window.removeEventListener("resize", this.handleResizeEvent);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.resizeObservedElements = [];
    if (this.resizeRafHandle) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = 0;
    }
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    const activeRenderPromise = this.activeRenderPromise;
    if (activeRenderPromise) {
      await activeRenderPromise.catch(() => undefined);
    }
    const rendererWithWait = this.renderer as WebGPURenderer & { waitForGPU?: () => Promise<void> };
    if (this.initialized && typeof rendererWithWait.waitForGPU === "function") {
      await rendererWithWait.waitForGPU();
    }
    await this.flushDeferredGpuDisposals();
    if (this.histogramStagingBuffer) {
      try {
        this.histogramStagingBuffer.destroy();
      } catch {
        // Buffer may already be released with the device.
      }
      this.histogramStagingBuffer = null;
      this.histogramStagingSize = 0;
    }
    this.cameraController.dispose();
    this.controls.dispose();
    this.actorTransformController?.dispose();
    this.curveEditController?.dispose();
    this.dimensionOverlayController?.dispose();
    this.sceneGridController.dispose();
    this.kernel.profiler.clearDrawHooks();
    this.sceneController.setRenderer(null);
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

  public async renderOnce(): Promise<void> {
    if (this.disposed) {
      throw new Error("Viewport has been disposed.");
    }
    if (!this.initialized) {
      if (typeof (this.renderer as any).init === "function") {
        await (this.renderer as any).init();
      }
      this.initialized = true;
      this.applyHdrConfiguration();
      this.setGpuTimestampTracking(false);
    }
    this.onResize();
    await this.renderFrame({ collectStats: false });
  }

  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Coordinated toggle for debug helpers (grid, axes, curve tangent
   * handles) and the actor transform gizmo. Use this anywhere that wants
   * a "clean" render — the transform gizmo is not owned by
   * SceneController, so calling setDebugHelpersVisible alone leaves it
   * on-screen. Pair this with a try/finally so the live viewport
   * recovers its previous state.
   */
  private setEditorHelpersVisible(visible: boolean): void {
    this.sceneController.setDebugHelpersVisible(visible);
    this.actorTransformController?.setVisible(visible);
  }

  public async captureViewportScreenshot(args: {
    width: number;
    height: number;
    useVideoRenderSettings: boolean;
  }): Promise<ViewportScreenshotResult> {
    if (this.disposed) {
      throw new Error("Viewport has been disposed.");
    }
    void args.width;
    void args.height;
    while (this.renderInFlight) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
    if (!args.useVideoRenderSettings) {
      // Capture exactly as the user sees it. One rAF wait so we sample a
      // committed swap-chain frame; blank-frame retry inside
      // captureViewportScreenshotFromCanvas handles the unlikely empty
      // read.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const asIs = await captureViewportScreenshotFromCanvas({
        backend: "webgpu",
        canvas: this.renderer.domElement
      });
      return { ...asIs, debugHelpersHidden: false };
    }
    const previousDebugHelpersVisible = this.sceneController.getDebugHelpersVisible();
    const previousTransformGizmoVisible = this.actorTransformController?.getVisible() ?? true;
    try {
      this.setEditorHelpersVisible(false);
      for (let passIndex = 0; passIndex < 2; passIndex += 1) {
        await this.renderOnce();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      const result = await captureViewportScreenshotFromCanvas({
        backend: "webgpu",
        canvas: this.renderer.domElement
      });
      return { ...result, debugHelpersHidden: true };
    } finally {
      this.sceneController.setDebugHelpersVisible(previousDebugHelpersVisible);
      this.actorTransformController?.setVisible(previousTransformGizmoVisible);
    }
  }

  public async captureViewportThumbnail(): Promise<ViewportThumbnailResult> {
    if (this.disposed) {
      throw new Error("Viewport has been disposed.");
    }
    while (this.renderInFlight) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
    const previousDebugHelpersVisible = this.sceneController.getDebugHelpersVisible();
    const previousTransformGizmoVisible = this.actorTransformController?.getVisible() ?? true;
    try {
      this.setEditorHelpersVisible(false);
      for (let passIndex = 0; passIndex < 2; passIndex += 1) {
        await this.renderOnce();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      return await captureViewportThumbnail({ canvas: this.renderer.domElement });
    } finally {
      this.sceneController.setDebugHelpersVisible(previousDebugHelpersVisible);
      this.actorTransformController?.setVisible(previousTransformGizmoVisible);
    }
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
    const renderPromise = this.renderFrame()
      .catch((error) => {
        if (!this.disposed) {
          console.warn("[simularca] WebGPU render frame failed:", error);
        }
      })
      .finally(() => {
        this.renderInFlight = false;
        if (this.activeRenderPromise === renderPromise) {
          this.activeRenderPromise = null;
        }
      });
    this.activeRenderPromise = renderPromise;
    bumpFrameCounter();
  };

  private async renderFrame(options?: { collectStats?: boolean }): Promise<void> {
    const collectStats = options?.collectStats ?? true;
    const wantsGpuTimings = this.kernel.profiler.shouldProfileGpuTimings();
    this.setGpuTimestampTracking(wantsGpuTimings);
    const _rf0 = performance.now();
    this.kernel.profiler.beginFrame();
    await this.kernel.profiler.withFrameChunk("Scene sync", () => this.sceneController.syncFromState());
    if (this.disposed) {
      this.kernel.profiler.clearDrawHooks();
      return;
    }
    // Note: syncFromState already runs pruneInvalidSceneGraph as its last phase,
    // so we don't repeat it here. The catch-path below still calls it
    // defensively if a render error mentions a null child.
    const _rf1 = performance.now();
    await this.kernel.profiler.withFrameChunk("Viewport sync", () => {
      this.syncCameraState();
      this.cameraController.update(performance.now());
      this.curveEditController?.setCamera(this.activeCamera);
      this.actorTransformController?.setCamera(this.activeCamera);
      this.dimensionOverlayController?.setCamera(this.activeCamera);
      this.curveEditController?.update();
      this.actorTransformController?.update();
      this.dimensionOverlayController?.update();
      this.sceneGridController.setCamera(this.activeCamera);
      this.sceneGridController.setViewportSize(this.lastAppliedSize?.width ?? 1, this.lastAppliedSize?.height ?? 1);
      this.sceneGridController.update();
      this.controls.update();
      this.enforceActorCompatibility("webgpu");
      this.syncCameraToState();
      this.syncToneMappingOutput();
    });
    const _rf2 = performance.now();
    const renderOnce = async (): Promise<void> => {
      const renderPromise =
        typeof (this.postProcessing as any).renderAsync === "function"
          ? (this.postProcessing as any).renderAsync()
          : Promise.resolve((this.postProcessing as any).render());
      await Promise.resolve(renderPromise);
    };
    await this.kernel.profiler.withFrameChunk("Render submission", async () => {
      this.kernel.profiler.syncDrawHooks(
        this.sceneController.listActorObjectsForProfiling().map(({ actorId, object }) => {
          const actor = this.kernel.store.getState().state.actors[actorId];
          return {
            actor: {
              actorId,
              actorName: actor?.name ?? actorId,
              actorType: actor?.actorType ?? "empty",
              pluginType: actor?.pluginType
            },
            object
          };
        })
      );
      try {
        await renderOnce();
      } catch (error) {
        if (this.disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Cannot read properties of null") && message.includes("visible")) {
          pruneInvalidSceneGraph(this.sceneController.scene);
          this.postProcessing.needsUpdate = true;
          await renderOnce();
        } else {
          throw error;
        }
      }
    });
    // Fire-and-forget HDR histogram readback of the just-rendered canvas. Live viewport
    // only (export renders use their own SDR canvas); runs while the HDR Preview panel is
    // subscribed; internally throttled and guarded.
    if (!this.disposed && !this.isExportViewport && isHdrHistogramEnabled()) {
      this.maybeCaptureHistogram();
    }
    await this.kernel.profiler.withFrameChunk("GPU resource cleanup", () => this.flushDeferredGpuDisposals());
    const gpu = wantsGpuTimings
      ? await this.kernel.profiler.withFrameChunk("GPU readback", () => this.resolveGpuProfile())
      : undefined;
    const _rf3 = performance.now();
    this.kernel.profiler.finishFrame({
      cpuTotalDurationMs: _rf3 - _rf0,
      gpu
    });
    if (collectStats) {
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
  }

  private syncCameraState(): void {
    const cameraState = this.kernel.store.getState().state.camera;
    this.activeCamera = cameraState.mode === "orthographic" ? this.orthographicCamera : this.perspectiveCamera;
    this.controls.object = this.activeCamera;
    if (cameraStatesApproximatelyEqual(cameraState, this.lastAppliedCameraState)) {
      return;
    }
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
    this.lastAppliedCameraState = cloneCameraState(cameraState);
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

  // Wrapper used by `window.addEventListener` and `ResizeObserver`. Class-field
  // arrows survive instance creation, but during Vite HMR cycles we observed the
  // listener-side `this.scheduleResize` going undefined and firing
  // "TypeError: ... is not a function" every animation frame. Catching here
  // ensures one bad HMR can't burn the renderer process.
  private handleResizeEvent = (): void => {
    if (this.disposed) {
      return;
    }
    try {
      this.scheduleResize();
    } catch (error) {
      console.warn("[simularca] resize listener failed; suppressing:", error);
    }
  };

  private scheduleResize = (): void => {
    if (this.disposed || this.resizeRafHandle) {
      return;
    }
    this.resizeRafHandle = requestAnimationFrame(() => {
      this.resizeRafHandle = 0;
      if (this.disposed) {
        return;
      }
      this.onResize();
    });
  };

  private onResize = (): void => {
    const { width, height } = this.getEffectiveViewportSize();
    const pixelRatio = this.computeRenderScale(width, height);
    if (
      this.lastAppliedSize &&
      this.lastAppliedSize.width === width &&
      this.lastAppliedSize.height === height &&
      this.lastAppliedSize.pixelRatio === pixelRatio
    ) {
      return;
    }
    this.lastAppliedSize = { width, height, pixelRatio };
    this.mountEl.style.width = `${width}px`;
    this.mountEl.style.height = `${height}px`;
    this.renderer.setPixelRatio(pixelRatio);
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

  private computeRenderScale(width: number, height: number): number {
    if (this.isExportViewport) {
      return 1;
    }
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const dimensionLimit = Math.max(1, this.maxRenderDimension / Math.max(safeWidth, safeHeight));
    return Math.max(0.5, Math.min(devicePixelRatio, dimensionLimit));
  }

  private updateStats(): void {
    this.reportColorBufferWarning();
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
      const splatStats = this.readGaussianSplatStats();
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
        requestedColorBufferPrecision: this.colorBufferPrecision.requestedPrecision,
        activeColorBufferPrecision: this.colorBufferPrecision.activePrecision,
        activeColorBufferFormat: this.colorBufferPrecision.statusFormatLabel,
        requestedAntialiasing: this.colorBufferPrecision.requestedAntialiasing,
        activeAntialiasing: this.colorBufferPrecision.activeAntialiasing,
        colorBufferWarning: this.colorBufferPrecision.warningMessage ?? "",
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
        projectFileBytes: estimatedProjectBytes,
        requestedColorBufferPrecision: this.colorBufferPrecision.requestedPrecision,
        activeColorBufferPrecision: this.colorBufferPrecision.activePrecision,
        activeColorBufferFormat: this.colorBufferPrecision.statusFormatLabel,
        requestedAntialiasing: this.colorBufferPrecision.requestedAntialiasing,
        activeAntialiasing: this.colorBufferPrecision.activeAntialiasing,
        colorBufferWarning: this.colorBufferPrecision.warningMessage ?? ""
      });
    }
  }

  private reportColorBufferWarning(): void {
    if (this.colorBufferPrecision.warningMessage === this.lastLoggedColorBufferWarning) {
      return;
    }
    this.lastLoggedColorBufferWarning = this.colorBufferPrecision.warningMessage;
    if (!this.colorBufferPrecision.warningMessage) {
      return;
    }
    this.kernel.store.getState().actions.addLog({
      level: "warn",
      message: `WebGPU render target policy adjusted: ${this.colorBufferPrecision.warningMessage}`,
      details: `Active intermediate format: ${this.colorBufferPrecision.statusFormatLabel}; MSAA ${this.colorBufferPrecision.activeAntialiasing ? "enabled" : "disabled"}`
    });
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
    const currentCamera = this.kernel.store.getState().state.camera;
    const nextCameraState = readViewportCameraState(this.activeCamera, this.controls.target, currentCamera);
    if (cameraStatesApproximatelyEqual(nextCameraState, currentCamera)) {
      return;
    }

    // Camera navigation should mark the project as stale so Save captures the current viewpoint.
    this.kernel.store.getState().actions.setCameraState(nextCameraState, true);
    this.lastAppliedCameraState = cloneCameraState(nextCameraState);
  }

  private syncAoCamera(): void {
    const target =
      this.activeCamera instanceof THREE.OrthographicCamera
        ? this.aoOrthographicCamera
        : this.aoPerspectiveCamera;
    target.copy(this.activeCamera, false);
    target.layers.set(AO_MESH_LAYER);
    target.updateMatrixWorld(true);
    this.aoCamera = target;
    // Only assign the pass.camera when the camera *reference* changes — not every
    // frame. Three.js v0.173 invalidates the pass's shader graph on camera setter,
    // which leaks TSL nodes (StorageBufferNode/VarNode/SplitNode et al) every frame.
    if (this.aoMeshPass.camera !== this.aoCamera) {
      this.aoMeshPass.camera = this.aoCamera;
    }
  }

  /**
   * Reconfigure the WebGPU canvas for HDR output (extended-range / brighter-than-white
   * + Display-P3 wide gamut) once the renderer backend has initialized. No-op when HDR
   * is disabled, unsupported, or the backend isn't ready. Falls back silently to the
   * backend's default SDR configuration when the runtime rejects the HDR config.
   *
   * Highlights only read as brighter-than-white when the pipeline writes values >1.0
   * (i.e. with tonemapping off); ACES compresses to SDR by design. The P3 gamut applies
   * in either tonemapping mode via `outputColorSpace` below.
   */
  private applyHdrConfiguration(): void {
    if (this.hdrConfigured || !this.hdrOutput) {
      return;
    }
    const backend = (this.renderer as any).backend;
    const context = backend?.context as GPUCanvasContext | undefined;
    const device = backend?.device as GPUDevice | undefined;
    if (!context || !device) {
      return;
    }
    if (configureCanvasForHdr(context, device)) {
      this.hdrConfigured = true;
      // Three derives the default-framebuffer pipeline color format from
      // utils.getPreferredCanvasFormat() (WebGPUUtils.getCurrentColorFormat). We
      // reconfigured the context to rgba16float, so the pipeline format must agree or
      // WebGPU rejects the draw. Override it before the first render — the backend has
      // not drawn yet at this point, so no stale pipeline exists.
      const utils = backend?.utils;
      if (utils) {
        utils.getPreferredCanvasFormat = () => "rgba16float";
      }
      // three r0.173 has no Display-P3 color space (no DisplayP3ColorSpace export /
      // "display-p3" value). Setting outputColorSpace to undefined poisons the
      // tone-mapping output node build. Fall back to sRGB when P3 isn't available so
      // HDR extended-range output still works without a wide-gamut transform.
      const displayP3ColorSpace = (THREE as any).DisplayP3ColorSpace;
      this.renderer.outputColorSpace = displayP3ColorSpace ?? THREE.SRGBColorSpace;
      // Force the tone-mapping output node to rebuild against the new color space.
      this.lastOutputSignature = "";
      this.syncToneMappingOutput();
    }
  }

  /**
   * Copy the just-rendered canvas texture to a staging buffer and build a linear
   * luminance histogram on the CPU, published to the HDR histogram bridge for the HDR
   * Preview panel. Fire-and-forget: throttled, guarded by `histogramBusy`, and tolerant
   * of the canvas format changing (rgba16float when HDR is on, 8-bit otherwise).
   */
  private maybeCaptureHistogram(): void {
    if (this.histogramBusy) {
      return;
    }
    const now = performance.now();
    if (now - this.histogramLastSampleMs < HISTOGRAM_SAMPLE_INTERVAL_MS) {
      return;
    }
    const backend = (this.renderer as any).backend;
    const context = backend?.context as GPUCanvasContext | undefined;
    const device = backend?.device as GPUDevice | undefined;
    if (!context || !device) {
      return;
    }
    let texture: GPUTexture;
    try {
      texture = context.getCurrentTexture();
    } catch {
      return;
    }
    const width = texture.width;
    const height = texture.height;
    if (width === 0 || height === 0) {
      return;
    }
    const format = texture.format;
    const isFloat = format === "rgba16float";
    const isBgra = format.startsWith("bgra");
    const bytesPerPixel = isFloat ? 8 : 4;
    const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
    const bufferSize = bytesPerRow * height;

    if (!this.histogramStagingBuffer || this.histogramStagingSize !== bufferSize) {
      this.histogramStagingBuffer?.destroy();
      this.histogramStagingBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      this.histogramStagingSize = bufferSize;
    }
    const staging = this.histogramStagingBuffer;

    this.histogramBusy = true;
    this.histogramLastSampleMs = now;
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: staging, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 }
      );
      device.queue.submit([encoder.finish()]);
    } catch {
      this.histogramBusy = false;
      return;
    }

    void staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (this.disposed) {
          return;
        }
        const view = new DataView(staging.getMappedRange());
        const totalPixels = width * height;
        const stride = Math.max(1, Math.floor(totalPixels / HISTOGRAM_MAX_SAMPLES));
        const bins = new Uint32Array(HDR_HISTOGRAM_BINS);
        const binScale = HDR_HISTOGRAM_BINS / HDR_HISTOGRAM_MAX;
        let overflow = 0;
        let totalSamples = 0;
        let hdrCount = 0;
        let peak = 0;
        for (let idx = 0; idx < totalPixels; idx += stride) {
          const x = idx % width;
          const y = (idx - x) / width;
          const offset = y * bytesPerRow + x * bytesPerPixel;
          let r: number;
          let g: number;
          let b: number;
          if (isFloat) {
            r = halfToFloat(view.getUint16(offset, true));
            g = halfToFloat(view.getUint16(offset + 2, true));
            b = halfToFloat(view.getUint16(offset + 4, true));
          } else {
            const c0 = view.getUint8(offset) / 255;
            const c1 = view.getUint8(offset + 1) / 255;
            const c2 = view.getUint8(offset + 2) / 255;
            r = isBgra ? c2 : c0;
            g = c1;
            b = isBgra ? c0 : c2;
          }
          const lum = 0.2126 * srgbEotf(r) + 0.7152 * srgbEotf(g) + 0.0722 * srgbEotf(b);
          totalSamples++;
          if (lum > peak) {
            peak = lum;
          }
          if (lum > 1) {
            hdrCount++;
          }
          if (lum >= HDR_HISTOGRAM_MAX) {
            overflow++;
          } else {
            let bin = Math.floor(lum * binScale);
            if (bin < 0) {
              bin = 0;
            } else if (bin >= HDR_HISTOGRAM_BINS) {
              bin = HDR_HISTOGRAM_BINS - 1;
            }
            bins[bin] = (bins[bin] ?? 0) + 1;
          }
        }
        publishHdrHistogram({
          bins,
          overflow,
          totalSamples,
          peakLuminance: peak,
          fractionHdr: totalSamples > 0 ? hdrCount / totalSamples : 0,
          isFloat
        });
      })
      .catch(() => {
        // Mapping can fail if the device is lost or the buffer was destroyed mid-flight.
      })
      .finally(() => {
        try {
          staging.unmap();
        } catch {
          // Already unmapped / destroyed.
        }
        this.histogramBusy = false;
      });
  }

  private syncToneMappingOutput(): void {
    const tonemapping = this.kernel.store.getState().state.scene.tonemapping;
    const postProcessing = this.kernel.store.getState().state.scene.postProcessing;
    const aoEnabled = postProcessing.ambientOcclusion.enabled;
    this.syncAoCamera();
    const signature = JSON.stringify({
      mode: tonemapping.mode,
      dither: tonemapping.dither,
      hdrPeak: tonemapping.hdrPeak,
      postProcessing,
      outputColorSpace: this.renderer.outputColorSpace,
      hdrActive: this.hdrConfigured,
      aoCameraType: this.aoCamera instanceof THREE.OrthographicCamera ? "ortho" : "persp"
    });
    this.renderer.toneMapping = threeToneMappingForMode(tonemapping.mode);
    if (this.scenePass.camera !== this.activeCamera) {
      this.scenePass.camera = this.activeCamera;
    }
    if (signature === this.lastOutputSignature) {
      return;
    }
    this.lastOutputSignature = signature;
    const aoSources = aoEnabled
      ? {
          meshDepth: this.aoMeshPass.getTextureNode("depth"),
          meshNormal: this.aoMeshPass.getTextureNode("normal"),
          sceneDepth: this.scenePass.getTextureNode("depth"),
          camera: this.aoCamera
        }
      : null;
    this.postProcessing.outputNode = buildWebGpuToneMappedOutputNode(
      this.scenePass.getTextureNode("output"),
      this.renderer.outputColorSpace,
      tonemapping,
      postProcessing,
      aoSources,
      this.hdrConfigured
    );
    this.postProcessing.needsUpdate = true;
  }

  private isWheelZoomEnabled(): boolean {
    return Boolean(this.activeCamera);
  }

  private readGaussianSplatStats(): { drawCalls: number; visibleCount: number; actorCount: number } {
    const statuses = Object.values(this.kernel.store.getState().state.actorStatusByActorId);
    let actorCount = 0;
    let visibleCount = 0;
    for (const status of statuses) {
      const backend = typeof status?.values?.backend === "string" ? status.values.backend : "";
      const loadState = typeof status?.values?.loadState === "string" ? status.values.loadState : "";
      if ((backend !== "spark-webgl" && backend !== "webgpu-tsl") || loadState !== "loaded") {
        continue;
      }
      actorCount += 1;
      const pointCount = status.values.pointCount;
      if (typeof pointCount === "number" && Number.isFinite(pointCount)) {
        visibleCount += Math.max(0, Math.floor(pointCount));
      }
    }
    return {
      drawCalls: actorCount,
      visibleCount,
      actorCount
    };
  }

  private async flushDeferredGpuDisposals(): Promise<void> {
    if (!this.sceneController.hasDeferredGpuDisposals()) {
      return;
    }
    const rendererWithWait = this.renderer as WebGPURenderer & { waitForGPU?: () => Promise<void> };
    if (typeof rendererWithWait.waitForGPU === "function") {
      await rendererWithWait.waitForGPU();
    }
    this.sceneController.flushDeferredGpuDisposals();
  }

  private setGpuTimestampTracking(enabled: boolean): void {
    const backend = (this.renderer as WebGPURenderer & { backend?: { trackTimestamp?: boolean } }).backend;
    if (backend && backend.trackTimestamp !== enabled) {
      backend.trackTimestamp = enabled;
    }
  }

  private async resolveGpuProfile(): Promise<ProfileFrameGpuInput> {
    const backend = (this.renderer as WebGPURenderer & { backend?: { trackTimestamp?: boolean } }).backend;
    const rendererWithTimestamps = this.renderer as WebGPURenderer & {
      resolveTimestampsAsync?: (type?: "render" | "compute") => Promise<number | undefined>;
    };
    const canResolve =
      backend?.trackTimestamp === true && typeof rendererWithTimestamps.resolveTimestampsAsync === "function";
    if (!canResolve) {
      return { status: "unavailable" };
    }
    try {
      const [renderMs, computeMs] = await Promise.all([
        rendererWithTimestamps.resolveTimestampsAsync!("render"),
        rendererWithTimestamps.resolveTimestampsAsync!("compute")
      ]);
      const roots = [];
      if (typeof renderMs === "number" && Number.isFinite(renderMs)) {
        roots.push({
          id: "gpu:render",
          label: "Render",
          durationMs: renderMs,
          children: []
        });
      }
      if (typeof computeMs === "number" && Number.isFinite(computeMs) && computeMs > 0) {
        roots.push({
          id: "gpu:compute",
          label: "Compute",
          durationMs: computeMs,
          children: []
        });
      }
      return roots.length > 0 ? { status: "captured", roots } : { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }
}

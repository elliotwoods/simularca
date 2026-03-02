import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import { SceneController } from "./sceneController";
import type { SplatOverlayActorState, SplatOverlayHandle } from "./splatOverlay";
import { DedicatedGaussianSplatOverlay, NoopSplatOverlay } from "./splatOverlay";

const ENABLE_DEDICATED_SPLAT_OVERLAY = true;

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
  private fpsLastTime = performance.now();
  private lastAppliedCameraSignature = "";
  private lastSplatSignature = "";
  private readonly assetUrlCache = new Map<string, string>();
  private readonly blobAssetUrls = new Set<string>();
  private dedicatedOverlayError: string | null = null;
  private splatSyncInFlight = false;
  private cachedSessionName = "";
  private started = false;
  private disposed = false;
  private initialized = false;
  private renderInFlight = false;

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
    this.renderer.setPixelRatio(window.devicePixelRatio);
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
    this.animate();
  }

  public stop(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
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
    const width = Math.max(1, this.mountEl.clientWidth);
    const height = Math.max(1, this.mountEl.clientHeight);
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

  private updateStats(): void {
    const now = performance.now();
    this.frameCount += 1;
    if (now - this.fpsLastTime < 300) {
      return;
    }
    const fps = (this.frameCount * 1000) / (now - this.fpsLastTime);
    this.frameCount = 0;
    this.fpsLastTime = now;
    const info = this.renderer.info;
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
      Math.abs(cameraUpdate.zoom - currentCamera.zoom) > 1e-6;
    if (moved) {
      this.kernel.store.getState().actions.setCameraState(cameraUpdate, false);
      this.lastAppliedCameraSignature = JSON.stringify({
        ...currentCamera,
        ...cameraUpdate
      });
    }
    this.kernel.store.getState().actions.setStats({
      fps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      actorCount: Object.keys(this.kernel.store.getState().state.actors).length
    });
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
          pointSize: Number(actor.params.pointSize ?? 0.02),
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
          if (this.splatOverlay.isDedicatedRenderer && assetUrl.startsWith("simularcaasset://")) {
            const bytes = await this.kernel.storage.readAssetBytes({
              sessionName: state.activeSessionName,
              relativePath: asset.relativePath
            });
            const normalizedBytes = new Uint8Array(bytes.byteLength);
            normalizedBytes.set(bytes);
            const blobUrl = URL.createObjectURL(new Blob([normalizedBytes.buffer], { type: "application/octet-stream" }));
            this.blobAssetUrls.add(blobUrl);
            assetUrl = blobUrl;
          }
          this.assetUrlCache.set(candidate.assetId, assetUrl);
        }
        actors.push({
          actorId: candidate.actorId,
          assetId: candidate.assetId,
          assetUrl,
          opacity: candidate.opacity,
          pointSize: candidate.pointSize,
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
}

function distanceSq3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

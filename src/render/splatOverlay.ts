import * as THREE from "three";

export interface SplatOverlayActorState {
  actorId: string;
  assetId: string;
  assetUrl: string;
  opacity: number;
  transform: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
}

export interface SplatOverlayHandle {
  isDedicatedRenderer: boolean;
  syncActors(actors: SplatOverlayActorState[]): Promise<void>;
  setCamera(camera: any): void;
  setSize(width: number, height: number): void;
  update(): void;
  dispose(): void;
}

export class NoopSplatOverlay implements SplatOverlayHandle {
  public readonly isDedicatedRenderer = false;
  public async syncActors(_actors: SplatOverlayActorState[]): Promise<void> {}
  public setCamera(_camera: any): void {}
  public setSize(_width: number, _height: number): void {}
  public update(): void {}
  public dispose(): void {}
}

type SplatModuleCandidate = {
  Viewer?: new (...args: unknown[]) => unknown;
  SceneFormat?: {
    Ply?: number;
  };
  default?: {
    Viewer?: new (...args: unknown[]) => unknown;
    SceneFormat?: {
      Ply?: number;
    };
    [key: string]: unknown;
  };
  "module.exports"?: {
    Viewer?: new (...args: unknown[]) => unknown;
    SceneFormat?: {
      Ply?: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const SPLAT_COORDINATE_CORRECTION_QUATERNION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ")
);

function withViewportAlignedSplatTransform(transform: SplatOverlayActorState["transform"]): {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  const actorQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(transform.rotation[0], transform.rotation[1], transform.rotation[2], "XYZ")
  );
  const correctedQuaternion = actorQuaternion.clone().multiply(SPLAT_COORDINATE_CORRECTION_QUATERNION);
  return {
    position: transform.position,
    rotation: [correctedQuaternion.x, correctedQuaternion.y, correctedQuaternion.z, correctedQuaternion.w],
    scale: transform.scale
  };
}

export class DedicatedGaussianSplatOverlay implements SplatOverlayHandle {
  public readonly isDedicatedRenderer = true;
  private viewer: any;
  private loaded = false;
  private readonly actorOrder: string[] = [];
  private activeCamera: any = null;
  private sceneFormatPly = 2;
  private readonly fallbackMaxRenderDimension = 4096;

  public constructor(
    private readonly rootElement: HTMLElement,
    private readonly onStatus: (message: string) => void
  ) {}

  public async initialize(): Promise<void> {
    const module = await this.loadModule();
    const ViewerCtor = this.resolveViewerCtor(module);
    if (!ViewerCtor) {
      const topLevelKeys = Object.keys(module);
      const defaultKeys =
        module.default && typeof module.default === "object" ? Object.keys(module.default as Record<string, unknown>) : [];
      const cjsKeys =
        module["module.exports"] && typeof module["module.exports"] === "object"
          ? Object.keys(module["module.exports"] as Record<string, unknown>)
          : [];
      throw new Error(
        [
          "No supported Viewer export found in Gaussian splat renderer module.",
          `Top-level keys: ${topLevelKeys.join(", ") || "(none)"}`,
          `default keys: ${defaultKeys.join(", ") || "(none)"}`,
          `module.exports keys: ${cjsKeys.join(", ") || "(none)"}`
        ].join(" ")
      );
    }

    this.viewer = new ViewerCtor({
      selfDrivenMode: false,
      useBuiltInControls: false,
      rootElement: this.rootElement,
      camera: this.activeCamera ?? undefined,
      sharedMemoryForWorkers: false,
      inMemoryCompressionLevel: 1,
      gpuAcceleratedSort: false
    });
    this.sceneFormatPly = this.resolvePlySceneFormat(module);
    if (!this.rootElement.style.position) {
      this.rootElement.style.position = "relative";
    }
    const domElement = this.viewer?.renderer?.domElement;
    if (domElement instanceof HTMLCanvasElement) {
      domElement.style.position = "absolute";
      domElement.style.inset = "0";
      domElement.style.width = "100%";
      domElement.style.height = "100%";
      domElement.style.pointerEvents = "none";
      domElement.style.zIndex = "3";
      domElement.style.background = "transparent";
    }
    this.loaded = true;
  }

  public async syncActors(actors: SplatOverlayActorState[]): Promise<void> {
    if (!this.loaded) {
      return;
    }
    await this.clearScenes();
    for (const actor of actors) {
      await this.addScene(actor);
      this.actorOrder.push(actor.actorId);
    }
  }

  public setCamera(camera: any): void {
    this.activeCamera = camera;
  }

  public setSize(width: number, height: number): void {
    if (!this.loaded || !this.viewer?.renderer) {
      return;
    }
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.applyRenderScale(safeWidth, safeHeight);
    this.viewer.renderer.setSize(safeWidth, safeHeight, false);
  }

  public update(): void {
    if (!this.loaded) {
      return;
    }
    if (this.activeCamera) {
      this.viewer.camera = this.activeCamera;
    }
    if (typeof this.viewer?.update === "function") {
      this.viewer.update();
    }
    if (typeof this.viewer?.render === "function") {
      this.viewer.render();
    }
  }

  public dispose(): void {
    if (!this.loaded) {
      return;
    }
    if (typeof this.viewer?.dispose === "function") {
      void this.viewer.dispose();
    }
    this.actorOrder.splice(0, this.actorOrder.length);
    this.loaded = false;
  }

  private async loadModule(): Promise<SplatModuleCandidate> {
    const failures: string[] = [];
    try {
      const module = (await import("@mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js")) as SplatModuleCandidate;
      this.onStatus("Dedicated splat renderer loaded: @mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js");
      return module;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`@mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js: ${message}`);
    }

    try {
      const module = (await import("@mkkellogg/gaussian-splats-3d")) as SplatModuleCandidate;
      this.onStatus("Dedicated splat renderer loaded: @mkkellogg/gaussian-splats-3d");
      return module;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`@mkkellogg/gaussian-splats-3d: ${message}`);
    }

    this.onStatus(
      "Dedicated splat renderer module not found or failed to load, using fallback point cloud path."
    );
    throw new Error(`Unable to import Gaussian splat renderer. Attempts: ${failures.join(" | ")}`);
  }

  private resolveViewerCtor(module: SplatModuleCandidate): (new (...args: unknown[]) => unknown) | null {
    if (typeof module.Viewer === "function") {
      return module.Viewer;
    }
    if (module.default && typeof module.default.Viewer === "function") {
      return module.default.Viewer;
    }
    const cjs = module["module.exports"];
    if (cjs && typeof cjs.Viewer === "function") {
      return cjs.Viewer;
    }
    return null;
  }

  private async addScene(actor: SplatOverlayActorState): Promise<void> {
    if (typeof this.viewer?.addSplatScene !== "function") {
      throw new Error("Gaussian splat viewer does not implement addSplatScene().");
    }
    const corrected = withViewportAlignedSplatTransform(actor.transform);
    await this.viewer.addSplatScene(actor.assetUrl, {
      showLoadingUI: false,
      progressiveLoad: false,
      format: this.sceneFormatPly,
      position: corrected.position,
      rotation: corrected.rotation,
      scale: corrected.scale
    });
  }

  private resolvePlySceneFormat(module: SplatModuleCandidate): number {
    const top = module.SceneFormat?.Ply;
    if (typeof top === "number") {
      return top;
    }
    const fromDefault = module.default?.SceneFormat?.Ply;
    if (typeof fromDefault === "number") {
      return fromDefault;
    }
    const fromCjs = module["module.exports"]?.SceneFormat?.Ply;
    if (typeof fromCjs === "number") {
      return fromCjs;
    }
    // Known value in gaussian-splats-3d v0.4.x
    return 2;
  }

  private async clearScenes(): Promise<void> {
    if (typeof this.viewer?.removeSplatScenes === "function") {
      const sceneCount = Number(this.viewer?.splatMesh?.scenes?.length ?? 0);
      if (sceneCount > 0) {
        const indexes = Array.from({ length: sceneCount }, (_entry, index) => index);
        await this.viewer.removeSplatScenes(indexes, false);
      }
      this.actorOrder.splice(0, this.actorOrder.length);
      return;
    }
    if (typeof this.viewer?.removeSplatScene === "function") {
      const sceneCount = Number(this.viewer?.splatMesh?.scenes?.length ?? 0);
      for (let index = sceneCount - 1; index >= 0; index -= 1) {
        await this.viewer.removeSplatScene(index, false);
      }
      this.actorOrder.splice(0, this.actorOrder.length);
    }
  }

  private applyRenderScale(width: number, height: number): void {
    if (!this.viewer?.renderer || typeof this.viewer.renderer.setPixelRatio !== "function") {
      return;
    }
    const maxTextureSize = Number(this.viewer.renderer?.capabilities?.maxTextureSize);
    const maxRenderDimension =
      Number.isFinite(maxTextureSize) && maxTextureSize > 0 ? maxTextureSize : this.fallbackMaxRenderDimension;
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const dimensionLimit = Math.max(1, maxRenderDimension / Math.max(width, height));
    const pixelRatio = Math.max(0.5, Math.min(devicePixelRatio, dimensionLimit));
    this.viewer.renderer.setPixelRatio(pixelRatio);
  }
}

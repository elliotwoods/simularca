import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

type SplatColorInputSpace = "linear" | "srgb" | "iphone-sdr" | "apple-log";
const SPARK_COORDINATE_CORRECTION_EULER = new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ");

interface SyncContext {
  actor: { id: string; params: Record<string, unknown> };
  state: unknown;
  profileChunk?<T>(label: string, run: () => T): T;
  setActorStatus(status: unknown): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
}

function parseSparkColorInputSpace(value: unknown): SplatColorInputSpace {
  return value === "linear" || value === "iphone-sdr" || value === "apple-log" || value === "srgb" ? value : "srgb";
}

function formatLoadError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readUnsupportedWarning(actor: { params: Record<string, unknown> }): string | null {
  const colorInputSpace = parseSparkColorInputSpace(actor.params.colorInputSpace);
  if (colorInputSpace !== "srgb") {
    return `Splat Output Transform "${colorInputSpace}" is ignored in WebGL2.`;
  }
  const splatSizeScale = actor.params.splatSizeScale;
  if (typeof splatSizeScale === "number" && Number.isFinite(splatSizeScale) && Math.abs(splatSizeScale - 1) > 1e-6) {
    return "Splat Size is only supported in the WebGPU backend and is ignored in WebGL2.";
  }
  return null;
}

export class SparkSplatController {
  private loadedAssetId = "";
  private loadedReloadToken = 0;
  private pendingAssetId = "";
  private pendingReloadToken = 0;
  private loadToken = 0;
  private mesh: any = null;
  private correctedRoot: THREE.Group | null = null;
  private pointCount = 0;
  private bounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
  private lastWarning: string | null = null;
  private profileChunk?: <T>(label: string, run: () => T) => T;

  public constructor(private readonly renderRoot: THREE.Group) {}

  public sync(context: SyncContext): void {
    this.profileChunk = context.profileChunk;
    const actor = context.actor;
    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;

    if (!assetId) {
      if (this.loadedAssetId || this.pendingAssetId) {
        this.dispose();
        context.setActorStatus(null);
      }
      return;
    }

    if (assetId !== this.loadedAssetId || reloadToken !== this.loadedReloadToken) {
      if (assetId !== this.pendingAssetId || reloadToken !== this.pendingReloadToken) {
        this.pendingAssetId = assetId;
        this.pendingReloadToken = reloadToken;
        this.runProfileChunk("Asset load request", () => {
          void this.loadAsset(assetId, reloadToken, context.readAssetBytes, context.setActorStatus);
        });
      }
      return;
    }

    if (!this.mesh) {
      return;
    }

    this.runProfileChunk("Runtime params", () => {
      this.applyRuntimeParams(actor, context.state);
    });
    this.runProfileChunk("Status refresh", () => {
      this.reportLoadedStatus(actor, context.setActorStatus);
    });
  }

  public dispose(): void {
    this.loadToken++;
    this.loadedAssetId = "";
    this.loadedReloadToken = 0;
    this.pendingAssetId = "";
    this.pendingReloadToken = 0;
    this.disposeRenderingResources();
  }

  private disposeRenderingResources(): void {
    this.pointCount = 0;
    this.bounds = null;
    this.lastWarning = null;
    if (this.mesh) {
      this.mesh.removeFromParent?.();
    }
    if (typeof this.mesh?.dispose === "function") {
      this.mesh.dispose();
    }
    this.mesh = null;
  }

  private runProfileChunk<T>(label: string, run: () => T): T {
    if (this.profileChunk) {
      return this.profileChunk(label, run);
    }
    return run();
  }

  private async loadAsset(
    assetId: string,
    reloadToken: number,
    readAssetBytes: (id: string) => Promise<Uint8Array>,
    setActorStatus: (status: unknown) => void
  ): Promise<void> {
    const localToken = ++this.loadToken;
    setActorStatus({
      values: {
        backend: "spark-webgl",
        loadState: "loading"
      },
      updatedAtIso: new Date().toISOString()
    });

    try {
      const bytes = await readAssetBytes(assetId);
      if (this.loadToken !== localToken) {
        return;
      }
      const correctedRoot = this.correctedRoot ?? new THREE.Group();
      correctedRoot.rotation.copy(SPARK_COORDINATE_CORRECTION_EULER);

      const mesh = new (SplatMesh as any)({
        fileBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });

      if (mesh?.initialized && typeof mesh.initialized.then === "function") {
        await mesh.initialized;
      }
      if (this.loadToken !== localToken) {
        mesh.removeFromParent?.();
        mesh.dispose?.();
        return;
      }

      this.disposeRenderingResources();
      if (!this.correctedRoot) {
        this.renderRoot.add(correctedRoot);
        this.correctedRoot = correctedRoot;
      } else if (correctedRoot.parent !== this.renderRoot) {
        this.renderRoot.add(correctedRoot);
      }
      correctedRoot.clear();
      correctedRoot.rotation.copy(SPARK_COORDINATE_CORRECTION_EULER);

      correctedRoot.add(mesh);
      this.loadedAssetId = assetId;
      this.loadedReloadToken = reloadToken;
      this.pendingAssetId = "";
      this.pendingReloadToken = 0;
      this.mesh = mesh;
      this.correctedRoot = correctedRoot;
      this.pointCount = Math.max(0, Math.floor(Number(mesh.numSplats ?? mesh.splatCount ?? 0)));
      const bounds = typeof mesh.getBoundingBox === "function" ? mesh.getBoundingBox() : null;
      this.bounds = bounds
        ? {
            min: [bounds.min.x, bounds.min.y, bounds.min.z],
            max: [bounds.max.x, bounds.max.y, bounds.max.z]
          }
        : null;
      setActorStatus({
        values: {
          backend: "spark-webgl",
          loadState: "loaded",
          pointCount: this.pointCount,
          boundsMin: this.bounds?.min ?? null,
          boundsMax: this.bounds?.max ?? null
        },
        updatedAtIso: new Date().toISOString()
      });
    } catch (error) {
      if (this.loadToken !== localToken) {
        return;
      }
      this.pendingAssetId = "";
      this.pendingReloadToken = 0;
      setActorStatus({
        values: {
          backend: "spark-webgl",
          loadState: "failed"
        },
        error: formatLoadError(error),
        updatedAtIso: new Date().toISOString()
      });
    }
  }

  private applyRuntimeParams(actor: { params: Record<string, unknown> }, _state: unknown): void {
    if (!this.mesh) {
      return;
    }

    const scaleFactor = Number(actor.params.scaleFactor ?? 1);
    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    this.mesh.scale?.setScalar?.(safeScale);

    const brightness = Number(actor.params.brightness ?? 1);
    const safeBrightness = Number.isFinite(brightness) ? Math.max(0, brightness) : 1;
    if (this.mesh.recolor instanceof THREE.Color) {
      this.mesh.recolor.setRGB(safeBrightness, safeBrightness, safeBrightness);
    }

    const opacity = Number(actor.params.opacity ?? 1);
    const safeOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    if (typeof this.mesh.setOpacity === "function") {
      this.mesh.setOpacity(safeOpacity);
    } else {
      if (typeof this.mesh.opacity === "number") {
        this.mesh.opacity = safeOpacity;
      }
      if (this.mesh.material && "opacity" in this.mesh.material) {
        this.mesh.material.opacity = safeOpacity;
        this.mesh.material.needsUpdate = true;
      }
    }

    if (typeof this.mesh.prepareViewpoint === "function") {
      this.mesh.prepareViewpoint(this.mesh.viewpoint ?? this.mesh.defaultView);
    }
  }

  private reportLoadedStatus(actor: { params: Record<string, unknown> }, setActorStatus: (status: unknown) => void): void {
    const warning = readUnsupportedWarning(actor);
    if (warning === this.lastWarning) {
      return;
    }
    this.lastWarning = warning;
    setActorStatus({
      values: {
        backend: "spark-webgl",
        loadState: "loaded",
        pointCount: this.pointCount,
        boundsMin: this.bounds?.min ?? null,
        boundsMax: this.bounds?.max ?? null,
        warning
      },
      updatedAtIso: new Date().toISOString()
    });
  }
}

import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode } from "@/core/types";
import { SceneController } from "@/render/sceneController";
import { parseSplatColorInputSpace } from "@/features/splats/colorSpace";

const SPARK_COORDINATE_CORRECTION_EULER = new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ");
const SPARK_RENDER_ROOT_NAME = "spark-render-root";
interface SparkActorEntry {
  assetId: string;
  reloadToken: number;
  mesh: any;
  correctedRoot: any;
}

function readUnsupportedWarning(actor: Pick<ActorNode, "params">): string | null {
  const warnings: string[] = [];
  const colorInputSpace = parseSplatColorInputSpace(actor.params.colorInputSpace);
  if (colorInputSpace !== "srgb") {
    warnings.push(`Splat Output Transform "${colorInputSpace}" is ignored in WebGL2.`);
  }
  const splatSizeScale = actor.params.splatSizeScale;
  if (typeof splatSizeScale === "number" && Number.isFinite(splatSizeScale) && Math.abs(splatSizeScale - 1) > 1e-6) {
    warnings.push("Splat Size is only supported in the WebGPU backend and is ignored in WebGL2.");
  }
  return warnings.length > 0 ? warnings.join(" ") : null;
}

export function isSparkStochasticDepthEnabled(actor: Pick<ActorNode, "params">): boolean {
  return actor.params.stochasticDepth === true;
}

export function applySparkStochasticDepthMode(mesh: any, enabled: boolean): void {
  if (mesh?.defaultView && typeof mesh.defaultView === "object") {
    mesh.defaultView.stochastic = enabled;
    if (typeof mesh.defaultView.sortUpdate === "function") {
      void mesh.defaultView.sortUpdate({});
    }
  }
  if (mesh?.viewpoint && typeof mesh.viewpoint === "object") {
    mesh.viewpoint.stochastic = enabled;
    if (typeof mesh.viewpoint.sortUpdate === "function") {
      void mesh.viewpoint.sortUpdate({});
    }
  }
  if (typeof mesh?.prepareViewpoint === "function") {
    mesh.prepareViewpoint(mesh.viewpoint ?? mesh.defaultView);
  }
  if (mesh?.material) {
    mesh.material.transparent = !enabled;
    mesh.material.depthWrite = enabled;
    mesh.material.needsUpdate = true;
  }
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

export class SparkSplatController {
  private readonly entriesByActorId = new Map<string, SparkActorEntry>();
  private loadingTokenByActorId = new Map<string, number>();
  private lastWarning: string | null = null;
  private pointCount = 0;
  private bounds: { min: [number, number, number]; max: [number, number, number] } | null = null;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController
  ) {}

  public async syncFromState(): Promise<void> {
    const state = this.kernel.store.getState().state;
    const sparkActors = Object.values(state.actors).filter((actor) => actor.actorType === "gaussian-splat-spark");
    const sparkActorIds = new Set(sparkActors.map((actor) => actor.id));

    for (const existingActorId of [...this.entriesByActorId.keys()]) {
      if (!sparkActorIds.has(existingActorId)) {
        this.disposeActorEntry(existingActorId);
      }
    }

    for (const actor of sparkActors) {
      await this.syncSparkActor(actor);
    }
  }

  public getRenderStats(): { drawCalls: number; visibleCount: number; actorCount: number } {
    let visibleCount = 0;
    for (const entry of this.entriesByActorId.values()) {
      visibleCount += Math.max(0, Math.floor(Number(entry.mesh?.numSplats ?? 0)));
    }
    return {
      drawCalls: this.entriesByActorId.size,
      visibleCount,
      actorCount: this.entriesByActorId.size
    };
  }

  public dispose(): void {
    for (const actorId of [...this.entriesByActorId.keys()]) {
      this.disposeActorEntry(actorId);
    }
    this.loadingTokenByActorId = new Map<string, number>();
    this.lastWarning = null;
    this.pointCount = 0;
    this.bounds = null;
  }

  private async syncSparkActor(actor: ActorNode): Promise<void> {
    const actorObject = this.sceneController.getActorObject(actor.id);
    if (!(actorObject instanceof THREE.Group)) {
      return;
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const reloadToken = typeof actor.params.assetIdReloadToken === "number" ? actor.params.assetIdReloadToken : 0;
    const existingEntry = this.entriesByActorId.get(actor.id);

    if (!assetId) {
      this.disposeActorEntry(actor.id);
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      return;
    }

    const activeProject = this.kernel.store.getState().state.activeProject;
    if (!activeProject) {
      this.disposeActorEntry(actor.id);
      this.kernel.store.getState().actions.setActorStatus(actor.id, null);
      return;
    }
    const asset = this.kernel.store.getState().state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          backend: "spark-webgl",
          loadState: "failed",
          transparencyMode: isSparkStochasticDepthEnabled(actor) ? "stochastic-depth" : "alpha-blended"
        },
        error: "Asset reference not found in project state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }

    const isLoaded =
      existingEntry && existingEntry.assetId === assetId && existingEntry.reloadToken === reloadToken && existingEntry.mesh;
    if (isLoaded) {
      this.applySparkRuntimeParams(existingEntry, actor);
      this.reportLoadedStatus(actor, undefined, undefined, undefined);
      return;
    }

    const loadToken = (this.loadingTokenByActorId.get(actor.id) ?? 0) + 1;
    this.loadingTokenByActorId.set(actor.id, loadToken);
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        backend: "spark-webgl",
        loadState: "loading",
        assetFileName: asset.sourceFileName,
        transparencyMode: isSparkStochasticDepthEnabled(actor) ? "stochastic-depth" : "alpha-blended"
      },
      updatedAtIso: new Date().toISOString()
    });

    try {
      const bytes = await this.kernel.storage.readAssetBytes({
        projectPath: activeProject.path,
        relativePath: asset.relativePath
      });
      if (this.loadingTokenByActorId.get(actor.id) !== loadToken) {
        return;
      }
      this.disposeActorEntry(actor.id);
      const correctedRoot =
        (actorObject.getObjectByName(SPARK_RENDER_ROOT_NAME) as THREE.Group | null) ?? new THREE.Group();
      correctedRoot.name = SPARK_RENDER_ROOT_NAME;
      if (correctedRoot.parent !== actorObject) {
        actorObject.add(correctedRoot);
      }
      correctedRoot.clear();
      correctedRoot.rotation.copy(SPARK_COORDINATE_CORRECTION_EULER);
      const mesh = new (SplatMesh as any)({
        fileBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });

      if (mesh?.initialized && typeof mesh.initialized.then === "function") {
        await mesh.initialized;
      }
      if (this.loadingTokenByActorId.get(actor.id) !== loadToken) {
        mesh.removeFromParent?.();
        mesh.dispose?.();
        return;
      }

      correctedRoot.add(mesh);
      const entry: SparkActorEntry = {
        assetId,
        reloadToken,
        mesh,
        correctedRoot,
      };
      this.applySparkRuntimeParams(entry, actor);
      const bounds = typeof mesh.getBoundingBox === "function" ? mesh.getBoundingBox() : null;
      const pointCount = Number(mesh.numSplats ?? mesh.splatCount ?? 0);
      this.pointCount = pointCount;
      this.bounds = bounds
        ? {
            min: [bounds.min.x, bounds.min.y, bounds.min.z],
            max: [bounds.max.x, bounds.max.y, bounds.max.z]
          }
        : null;
      this.entriesByActorId.set(actor.id, entry);
      this.reportLoadedStatus(actor, asset.sourceFileName, pointCount, this.bounds);
      this.kernel.store.getState().actions.setStatus(
        `Gaussian splat loaded (Spark): ${asset.sourceFileName} | points: ${pointCount.toLocaleString()}`
      );
    } catch (error) {
      if (this.loadingTokenByActorId.get(actor.id) !== loadToken) {
        return;
      }
      this.disposeActorEntry(actor.id);
      const message = formatLoadError(error);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          backend: "spark-webgl",
          loadState: "failed",
          assetFileName: asset.sourceFileName,
          transparencyMode: isSparkStochasticDepthEnabled(actor) ? "stochastic-depth" : "alpha-blended"
        },
        error: message,
        updatedAtIso: new Date().toISOString()
      });
      this.kernel.store.getState().actions.setStatus(`Gaussian splat load failed (Spark): ${asset.sourceFileName} (${message})`);
    }
  }

  private disposeActorEntry(actorId: string): void {
    const existing = this.entriesByActorId.get(actorId);
    if (!existing) {
      return;
    }
    this.pointCount = 0;
    this.bounds = null;
    existing.mesh.removeFromParent?.();
    if (typeof existing.mesh?.dispose === "function") {
      existing.mesh.dispose();
    }
    this.entriesByActorId.delete(actorId);
  }

  private applySparkRuntimeParams(entry: SparkActorEntry, actor: ActorNode): void {
    const { mesh } = entry;
    applySparkStochasticDepthMode(mesh, isSparkStochasticDepthEnabled(actor));

    const scaleFactor = Number(actor.params.scaleFactor ?? 1);
    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    mesh.scale?.setScalar?.(safeScale);

    const brightness = Number(actor.params.brightness ?? 1);
    const safeBrightness = Number.isFinite(brightness) ? Math.max(0, brightness) : 1;
    if (mesh.recolor instanceof THREE.Color) {
      mesh.recolor.setRGB(safeBrightness, safeBrightness, safeBrightness);
    }

    const opacity = Number(actor.params.opacity ?? 1);
    const safeOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    if (typeof mesh.setOpacity === "function") {
      mesh.setOpacity(safeOpacity);
    } else {
      if (typeof mesh.opacity === "number") {
        mesh.opacity = safeOpacity;
      }
      if (mesh.material && "opacity" in mesh.material) {
        mesh.material.opacity = safeOpacity;
        mesh.material.needsUpdate = true;
      }
    }
    if (typeof mesh.prepareViewpoint === "function") {
      mesh.prepareViewpoint(mesh.viewpoint ?? mesh.defaultView);
    }
  }

  private reportLoadedStatus(
    actor: ActorNode,
    assetFileName: string | undefined,
    pointCount: number | undefined,
    bounds: { min: [number, number, number]; max: [number, number, number] } | null | undefined
  ): void {
    const warning = readUnsupportedWarning(actor);
    if (warning === this.lastWarning && assetFileName === undefined) {
      return;
    }
    this.lastWarning = warning;
    this.kernel.store.getState().actions.setActorStatus(actor.id, {
      values: {
        backend: "spark-webgl",
        loadState: "loaded",
        assetFileName,
        pointCount: pointCount ?? this.pointCount,
        transparencyMode: isSparkStochasticDepthEnabled(actor) ? "stochastic-depth" : "alpha-blended",
        boundsMin: bounds?.min ?? this.bounds?.min ?? undefined,
        boundsMax: bounds?.max ?? this.bounds?.max ?? undefined,
        warning
      },
      updatedAtIso: new Date().toISOString()
    });
  }
}




import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, SplatColorInputSpace } from "@/core/types";
import { SceneController } from "@/render/sceneController";

const SPARK_COORDINATE_CORRECTION_EULER = new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ");
interface SparkColorControls {
  decodeEnabled: { value: boolean };
  colorInputSpace: { value: number };
}

interface SparkActorEntry {
  assetId: string;
  reloadToken: number;
  mesh: any;
  correctedRoot: any;
  colorControls: SparkColorControls;
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

function parseSparkColorInputSpace(value: unknown): SplatColorInputSpace {
  return value === "linear" || value === "iphone-sdr" || value === "srgb" ? value : "srgb";
}

function sparkColorInputSpaceCode(value: SplatColorInputSpace): number {
  if (value === "linear") {
    return 0;
  }
  if (value === "iphone-sdr") {
    return 2;
  }
  return 1;
}

function createSparkColorControls(): SparkColorControls {
  return {
    decodeEnabled: { value: false },
    colorInputSpace: { value: 1 }
  };
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

    const activeProjectName = this.kernel.store.getState().state.activeProjectName;
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
        projectName: activeProjectName,
        relativePath: asset.relativePath
      });
      if (this.loadingTokenByActorId.get(actor.id) !== loadToken) {
        return;
      }
      this.disposeActorEntry(actor.id);

      const correctedRoot = new THREE.Group();
      correctedRoot.rotation.copy(SPARK_COORDINATE_CORRECTION_EULER);
      actorObject.add(correctedRoot);
      const colorControls = createSparkColorControls();
      const mesh = new (SplatMesh as any)({
        fileBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });

      if (mesh?.initialized && typeof mesh.initialized.then === "function") {
        await mesh.initialized;
      }
      if (this.loadingTokenByActorId.get(actor.id) !== loadToken) {
        mesh.dispose?.();
        correctedRoot.parent?.remove(correctedRoot);
        return;
      }

      correctedRoot.add(mesh);
      const entry: SparkActorEntry = {
        assetId,
        reloadToken,
        mesh,
        correctedRoot,
        colorControls
      };
      this.applySparkRuntimeParams(entry, actor);

      const bounds = typeof mesh.getBoundingBox === "function" ? mesh.getBoundingBox() : null;
      const pointCount = Number(mesh.numSplats ?? mesh.splatCount ?? 0);
      this.entriesByActorId.set(actor.id, entry);
      this.kernel.store.getState().actions.setActorStatus(actor.id, {
        values: {
          backend: "spark-webgl",
          loadState: "loaded",
          assetFileName: asset.sourceFileName,
          pointCount,
          transparencyMode: isSparkStochasticDepthEnabled(actor) ? "stochastic-depth" : "alpha-blended",
          boundsMin: bounds ? [bounds.min.x, bounds.min.y, bounds.min.z] : undefined,
          boundsMax: bounds ? [bounds.max.x, bounds.max.y, bounds.max.z] : undefined
        },
        updatedAtIso: new Date().toISOString()
      });
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
    existing.correctedRoot.parent?.remove(existing.correctedRoot);
    if (typeof existing.mesh?.dispose === "function") {
      existing.mesh.dispose();
    }
    this.entriesByActorId.delete(actorId);
  }

  private applySparkRuntimeParams(entry: SparkActorEntry, actor: ActorNode): void {
    const { mesh, colorControls } = entry;
    applySparkStochasticDepthMode(mesh, isSparkStochasticDepthEnabled(actor));

    const scaleFactor = Number(actor.params.scaleFactor ?? 1);
    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    mesh.scale?.setScalar?.(safeScale);

    const brightness = Number(actor.params.brightness ?? 1);
    const safeBrightness = Number.isFinite(brightness) ? Math.max(0, brightness) : 1;
    if (mesh.recolor instanceof THREE.Color) {
      mesh.recolor.setRGB(safeBrightness, safeBrightness, safeBrightness);
    }

    const colorInputSpace = parseSparkColorInputSpace(actor.params.colorInputSpace);
    const tonemappingEnabled = this.kernel.store.getState().state.scene.tonemapping.mode !== "off";
    colorControls.decodeEnabled.value = tonemappingEnabled;
    colorControls.colorInputSpace.value = sparkColorInputSpaceCode(colorInputSpace);

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
}




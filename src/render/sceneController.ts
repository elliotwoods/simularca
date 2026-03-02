import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode } from "@/core/types";

function formatLoadError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const maybeTarget = (error as { target?: { status?: number; statusText?: string } }).target;
    if (maybeTarget?.status !== undefined) {
      return `HTTP ${String(maybeTarget.status)} ${maybeTarget.statusText ?? ""}`.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown loader error object";
    }
  }
  return String(error);
}

export class SceneController {
  public readonly scene = new THREE.Scene();
  private readonly actorObjects = new Map<string, any>();
  private readonly gaussianAssetByActorId = new Map<string, string>();
  private readonly primitiveSignatureByActorId = new Map<string, string>();
  private readonly plyLoader = new PLYLoader();
  private readonly rgbeLoader = new RGBELoader();
  private readonly ktx2Loader = new KTX2Loader();
  private currentEnvironmentAssetId: string | null = null;
  private renderGaussianSplatFallback = true;

  public constructor(private readonly kernel: AppKernel) {
    this.scene.background = new THREE.Color("#070b12");
    const grid = new THREE.GridHelper(20, 20, 0x2f8f9d, 0x1f2430);
    (grid.material as any).transparent = true;
    (grid.material as any).opacity = 0.35;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(2.5));
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(8, 12, 6);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.ktx2Loader.setTranscoderPath("/basis/");
  }

  public async syncFromState(): Promise<void> {
    const state = this.kernel.store.getState().state;
    const actorIds = new Set(Object.keys(state.actors));

    for (const existing of [...this.actorObjects.keys()]) {
      if (!actorIds.has(existing)) {
        const object = this.actorObjects.get(existing);
        if (object) {
          this.scene.remove(object);
        }
        this.actorObjects.delete(existing);
        this.gaussianAssetByActorId.delete(existing);
        this.primitiveSignatureByActorId.delete(existing);
      }
    }

    for (const actor of Object.values(state.actors)) {
      if (actor.actorType === "gaussian-splat" && !this.renderGaussianSplatFallback) {
        const existing = this.actorObjects.get(actor.id);
        if (existing) {
          this.scene.remove(existing);
          this.actorObjects.delete(actor.id);
        }
        continue;
      }
      await this.ensureActorObject(actor);
      if (actor.actorType === "gaussian-splat" && this.renderGaussianSplatFallback) {
        await this.syncGaussianSplatAsset(actor);
      }
      if (actor.actorType === "primitive") {
        this.syncPrimitiveActor(actor);
      }
      this.applyActorTransform(actor);
    }

    await this.updateEnvironmentTexture();
  }

  public setGaussianSplatFallbackEnabled(enabled: boolean): void {
    this.renderGaussianSplatFallback = enabled;
  }

  private async ensureActorObject(actor: ActorNode): Promise<void> {
    if (!this.actorObjects.has(actor.id)) {
      const object = await this.createObjectForActor(actor);
      this.actorObjects.set(actor.id, object);
      this.scene.add(object);
    }
  }

  private async createObjectForActor(actor: ActorNode): Promise<any> {
    if (actor.actorType === "gaussian-splat") {
      const points = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({
          size: Number(actor.params.pointSize ?? 0.02),
          color: 0x8bd3ff,
          transparent: true,
          opacity: Number(actor.params.opacity ?? 1)
        })
      );
      points.frustumCulled = false;
      return points;
    }

    if (actor.actorType === "environment") {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.15),
        new THREE.MeshStandardMaterial({ color: 0x33ffaa, emissive: 0x112222 })
      );
      return marker;
    }

    if (actor.actorType === "primitive") {
      return this.createPrimitiveMesh(actor);
    }

    if (actor.actorType === "plugin") {
      return new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.25, 0.25),
        new THREE.MeshStandardMaterial({ color: 0xfa9a00 })
      );
    }

    return new THREE.Group();
  }

  private createPrimitiveGeometry(shape: string, size: number, segments: number): any {
    const radius = Math.max(0.05, size * 0.5);
    const safeSegments = Math.max(3, Math.floor(segments));
    switch (shape) {
      case "sphere":
        return new THREE.SphereGeometry(radius, safeSegments, safeSegments);
      case "torus":
        return new THREE.TorusGeometry(radius, Math.max(0.01, radius * 0.3), safeSegments, safeSegments * 2);
      case "cylinder":
        return new THREE.CylinderGeometry(radius, radius, Math.max(0.05, size), safeSegments);
      case "cone":
        return new THREE.ConeGeometry(radius, Math.max(0.05, size), safeSegments);
      case "icosahedron":
        return new THREE.IcosahedronGeometry(radius, 1);
      case "cube":
      default:
        return new THREE.BoxGeometry(Math.max(0.05, size), Math.max(0.05, size), Math.max(0.05, size));
    }
  }

  private createPrimitiveMesh(actor: ActorNode): any {
    const shape = typeof actor.params.shape === "string" ? actor.params.shape : "cube";
    const size = Number(actor.params.size ?? 1);
    const segments = Number(actor.params.segments ?? 24);
    const color = typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff";
    const wireframe = Boolean(actor.params.wireframe);
    const mesh = new THREE.Mesh(
      this.createPrimitiveGeometry(shape, size, segments),
      new THREE.MeshStandardMaterial({
        color,
        wireframe,
        metalness: 0.08,
        roughness: 0.72
      })
    );
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  private syncPrimitiveActor(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const shape = typeof actor.params.shape === "string" ? actor.params.shape : "cube";
    const size = Number(actor.params.size ?? 1);
    const segments = Number(actor.params.segments ?? 24);
    const color = typeof actor.params.color === "string" ? actor.params.color : "#4fb3ff";
    const wireframe = Boolean(actor.params.wireframe);
    const signature = JSON.stringify({
      shape,
      size: Number.isFinite(size) ? size : 1,
      segments: Number.isFinite(segments) ? segments : 24,
      color,
      wireframe
    });
    const previous = this.primitiveSignatureByActorId.get(actor.id);
    if (signature === previous) {
      return;
    }
    this.primitiveSignatureByActorId.set(actor.id, signature);

    // Avoid disposing geometry here: WebGPU renderer can still reference buffers during async pipeline updates.
    object.geometry = this.createPrimitiveGeometry(shape, size, segments);
    const material = object.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.set(color);
      material.wireframe = wireframe;
      material.needsUpdate = true;
    }
  }

  private applyActorTransform(actor: ActorNode): void {
    const object = this.actorObjects.get(actor.id);
    if (!object) {
      return;
    }
    object.visible = actor.enabled;
    object.position.set(...actor.transform.position);
    object.rotation.set(...actor.transform.rotation);
    object.scale.set(...actor.transform.scale);
    if (actor.actorType === "gaussian-splat" && object instanceof THREE.Points) {
      const material = object.material;
      if (material instanceof THREE.PointsMaterial) {
        const opacity = Number(actor.params.opacity ?? 1);
        const pointSize = Number(actor.params.pointSize ?? 0.02);
        material.opacity = Number.isFinite(opacity) ? opacity : 1;
        material.size = Number.isFinite(pointSize) ? pointSize : 0.02;
      }
    }
  }

  private async syncGaussianSplatAsset(actor: ActorNode): Promise<void> {
    const object = this.actorObjects.get(actor.id);
    if (!(object instanceof THREE.Points)) {
      return;
    }
    const material = object.material;
    if (material instanceof THREE.PointsMaterial) {
      material.opacity = Number(actor.params.opacity ?? 1);
      material.size = Number(actor.params.pointSize ?? 0.02);
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const previousAssetId = this.gaussianAssetByActorId.get(actor.id) ?? "";
    if (assetId === previousAssetId) {
      return;
    }
    this.gaussianAssetByActorId.set(actor.id, assetId);
    if (!assetId) {
      object.geometry.dispose();
      object.geometry = new THREE.BufferGeometry();
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      return;
    }
    const url = await this.kernel.storage.resolveAssetPath({
      sessionName: state.activeSessionName,
      relativePath: asset.relativePath
    });
    this.plyLoader.load(
      url,
      (geometry) => {
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const position = geometry.getAttribute("position");
        const pointCount = position?.count ?? 0;
        const bounds = geometry.boundingBox;
        const material = object.material;
        if (material instanceof THREE.PointsMaterial) {
          material.vertexColors = geometry.hasAttribute("color");
        }
        object.geometry.dispose();
        object.geometry = geometry;

        if (bounds) {
          const min = `${bounds.min.x.toFixed(3)}, ${bounds.min.y.toFixed(3)}, ${bounds.min.z.toFixed(3)}`;
          const max = `${bounds.max.x.toFixed(3)}, ${bounds.max.y.toFixed(3)}, ${bounds.max.z.toFixed(3)}`;
          const maxExtent = Math.max(
            bounds.max.x - bounds.min.x,
            bounds.max.y - bounds.min.y,
            bounds.max.z - bounds.min.z
          );
          const suggestedPointSize = Math.max(0.02, Math.min(0.2, maxExtent / 1500));
          const currentPointSize = Number(actor.params.pointSize ?? 0.02);
          if (Number.isFinite(currentPointSize) && currentPointSize < suggestedPointSize) {
            this.kernel.store.getState().actions.updateActorParams(actor.id, {
              pointSize: Number(suggestedPointSize.toFixed(3))
            });
          }
          this.kernel.store
            .getState()
            .actions.setStatus(
              `Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount} | bounds: [${min}] -> [${max}] | pointSize: ${Number(suggestedPointSize.toFixed(3))}`
            );
        } else {
          this.kernel.store
            .getState()
            .actions.setStatus(`Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount}`);
        }
      },
      undefined,
      (error) => {
        this.kernel.store
          .getState()
          .actions.setStatus(`Gaussian splat load failed: ${asset.sourceFileName} (${formatLoadError(error)})`);
      }
    );
  }

  private async updateEnvironmentTexture(): Promise<void> {
    const state = this.kernel.store.getState().state;
    const environmentActor = Object.values(state.actors).find((actor) => actor.actorType === "environment");
    if (!environmentActor) {
      if (this.currentEnvironmentAssetId) {
        this.scene.environment = null;
        this.scene.background = new THREE.Color("#070b12");
        this.currentEnvironmentAssetId = null;
      }
      return;
    }

    const assetId = typeof environmentActor.params.assetId === "string" ? environmentActor.params.assetId : null;
    if (!assetId || assetId === this.currentEnvironmentAssetId) {
      return;
    }

    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      return;
    }
    const url = await this.kernel.storage.resolveAssetPath({
      sessionName: state.activeSessionName,
      relativePath: asset.relativePath
    });

    const extension = asset.relativePath.split(".").pop()?.toLowerCase();
    if (extension === "ktx2") {
      this.ktx2Loader.load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.scene.environment = texture;
          this.scene.background = texture;
          this.currentEnvironmentAssetId = asset.id;
        },
        undefined,
        () => {
          this.kernel.store.getState().actions.setStatus(
            "KTX2 environment load failed. Ensure basis transcoder files are available in /public/basis."
          );
        }
      );
      return;
    }

    this.rgbeLoader.load(
      url,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.scene.environment = texture;
        this.scene.background = texture;
        this.currentEnvironmentAssetId = asset.id;
      },
      undefined,
      () => {
        this.kernel.store.getState().actions.setStatus("Environment texture load failed.");
      }
    );
  }
}

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

function getAttribute(geometry: any, names: string[]): any {
  for (const name of names) {
    const attribute = geometry.getAttribute?.(name);
    if (attribute) {
      return attribute;
    }
  }
  return null;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class SceneController {
  public readonly scene = new THREE.Scene();
  private readonly actorObjects = new Map<string, any>();
  private readonly gaussianAssetByActorId = new Map<string, string>();
  private readonly gaussianBoundsHelpers = new Map<string, any>();
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
        const helper = this.gaussianBoundsHelpers.get(existing);
        if (helper) {
          this.scene.remove(helper);
          this.gaussianBoundsHelpers.delete(existing);
        }
        this.kernel.store.getState().actions.setSplatDiagnostics(existing, null);
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
      const group = new THREE.Group();
      group.name = "gaussian-splat-container";
      return group;
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
    if (!(object instanceof THREE.Group)) {
      return;
    }

    const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
    const previousAssetId = this.gaussianAssetByActorId.get(actor.id) ?? "";
    if (assetId === previousAssetId) {
      return;
    }
    this.gaussianAssetByActorId.set(actor.id, assetId);
    if (!assetId) {
      this.kernel.store.getState().actions.setSplatDiagnostics(actor.id, null);
      object.geometry.dispose();
      object.geometry = new THREE.BufferGeometry();
      return;
    }

    const state = this.kernel.store.getState().state;
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      this.kernel.store.getState().actions.setSplatDiagnostics(actor.id, {
        backend: this.renderGaussianSplatFallback ? "fallback-ply" : "dedicated-overlay",
        loader: this.renderGaussianSplatFallback ? "three/examples/jsm/loaders/PLYLoader" : "gaussian-splats-3d",
        loaderVersion: THREE.REVISION,
        error: "Asset reference not found in session state.",
        updatedAtIso: new Date().toISOString()
      });
      return;
    }
    const url = await this.kernel.storage.resolveAssetPath({
      sessionName: state.activeSessionName,
      relativePath: asset.relativePath
    });
    this.plyLoader.load(
      url,
      (geometry) => {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const position = geometry.getAttribute("position");
        const pointCount = position?.count ?? 0;
        const bounds = geometry.boundingBox;
        const existing = object.getObjectByName("gaussian-splat-render");
        if (existing) {
          object.remove(existing);
        }
        const pointSize = Number(actor.params.pointSize ?? 0.02);
        const opacity = Number(actor.params.opacity ?? 1);
        const renderMesh = this.buildGaussianFallbackMesh(geometry, pointSize, opacity);
        renderMesh.name = "gaussian-splat-render";
        object.add(renderMesh);

        if (bounds) {
          const min = `${bounds.min.x.toFixed(3)}, ${bounds.min.y.toFixed(3)}, ${bounds.min.z.toFixed(3)}`;
          const max = `${bounds.max.x.toFixed(3)}, ${bounds.max.y.toFixed(3)}, ${bounds.max.z.toFixed(3)}`;
          const maxExtent = Math.max(
            bounds.max.x - bounds.min.x,
            bounds.max.y - bounds.min.y,
            bounds.max.z - bounds.min.z
          );
          const suggestedPointSize = Math.max(0.02, Math.min(0.25, maxExtent / 1200));
          const currentPointSize = Number(actor.params.pointSize ?? 0.02);
          if (Number.isFinite(currentPointSize) && currentPointSize < suggestedPointSize) {
            this.kernel.store.getState().actions.updateActorParams(actor.id, {
              pointSize: Number(suggestedPointSize.toFixed(3))
            });
          }
          let helper = this.gaussianBoundsHelpers.get(actor.id);
          if (!helper) {
            helper = new THREE.Box3Helper(bounds.clone(), 0xff5bd6);
            this.gaussianBoundsHelpers.set(actor.id, helper);
            this.scene.add(helper);
          } else {
            helper.box.copy(bounds);
          }
          this.kernel.store
            .getState()
            .actions.setStatus(
              `Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount} | bounds: [${min}] -> [${max}] | pointSize: ${Number(suggestedPointSize.toFixed(3))}`
            );
          this.kernel.store.getState().actions.setSplatDiagnostics(actor.id, {
            backend: this.renderGaussianSplatFallback ? "fallback-ply" : "dedicated-overlay",
            loader: this.renderGaussianSplatFallback ? "three/examples/jsm/loaders/PLYLoader" : "gaussian-splats-3d",
            loaderVersion: THREE.REVISION,
            assetFileName: asset.sourceFileName,
            pointCount,
            boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
            boundsMax: [bounds.max.x, bounds.max.y, bounds.max.z],
            updatedAtIso: new Date().toISOString()
          });
        } else {
          this.kernel.store
            .getState()
            .actions.setStatus(`Gaussian splat loaded: ${asset.sourceFileName} | points: ${pointCount}`);
          this.kernel.store.getState().actions.setSplatDiagnostics(actor.id, {
            backend: this.renderGaussianSplatFallback ? "fallback-ply" : "dedicated-overlay",
            loader: this.renderGaussianSplatFallback ? "three/examples/jsm/loaders/PLYLoader" : "gaussian-splats-3d",
            loaderVersion: THREE.REVISION,
            assetFileName: asset.sourceFileName,
            pointCount,
            updatedAtIso: new Date().toISOString()
          });
        }
      },
      undefined,
      (error) => {
        const errorMessage = formatLoadError(error);
        this.kernel.store.getState().actions.setSplatDiagnostics(actor.id, {
          backend: this.renderGaussianSplatFallback ? "fallback-ply" : "dedicated-overlay",
          loader: this.renderGaussianSplatFallback ? "three/examples/jsm/loaders/PLYLoader" : "gaussian-splats-3d",
          loaderVersion: THREE.REVISION,
          assetFileName: asset.sourceFileName,
          error: errorMessage,
          updatedAtIso: new Date().toISOString()
        });
        this.kernel.store
          .getState()
          .actions.setStatus(`Gaussian splat load failed: ${asset.sourceFileName} (${errorMessage})`);
      }
    );
  }

  private buildGaussianFallbackMesh(geometry: any, pointSize: number, opacity: number): any {
    const position = geometry.getAttribute("position");
    if (!position) {
      return new THREE.Group();
    }
    const color = getAttribute(geometry, ["color", "rgb", "diffuse"]);
    const red = getAttribute(geometry, ["red"]);
    const green = getAttribute(geometry, ["green"]);
    const blue = getAttribute(geometry, ["blue"]);
    const fdc0 = getAttribute(geometry, ["f_dc_0"]);
    const fdc1 = getAttribute(geometry, ["f_dc_1"]);
    const fdc2 = getAttribute(geometry, ["f_dc_2"]);
    const opacityAttr = getAttribute(geometry, ["opacity", "alpha"]);
    const scale0 = getAttribute(geometry, ["scale_0", "sx"]);
    const scale1 = getAttribute(geometry, ["scale_1", "sy"]);
    const scale2 = getAttribute(geometry, ["scale_2", "sz"]);
    const rot0 = getAttribute(geometry, ["rot_0", "qw"]);
    const rot1 = getAttribute(geometry, ["rot_1", "qx"]);
    const rot2 = getAttribute(geometry, ["rot_2", "qy"]);
    const rot3 = getAttribute(geometry, ["rot_3", "qz"]);

    const maxInstances = 50000;
    const stride = Math.max(1, Math.ceil(position.count / maxInstances));
    const instanceCount = Math.ceil(position.count / stride);
    const baseRadius = Math.max(0.002, pointSize * 0.1);
    const baseGeometry = new THREE.SphereGeometry(baseRadius, 6, 5);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: Math.min(1, Math.max(0, opacity)),
      vertexColors: Boolean(color || red || fdc0)
    });
    const mesh = new THREE.InstancedMesh(baseGeometry, material, instanceCount);
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const translation = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const rotation = new THREE.Quaternion();
    const tempColor = new THREE.Color(0xffffff);
    const SH_C0 = 0.28209479177387814;

    let cursor = 0;
    for (let index = 0; index < position.count; index += stride) {
      translation.set(position.getX(index), position.getY(index), position.getZ(index));

      if (scale0 && scale1 && scale2) {
        // 3DGS stores log-scales in many PLY exports.
        const sx = Math.exp(scale0.getX(index));
        const sy = Math.exp(scale1.getX(index));
        const sz = Math.exp(scale2.getX(index));
        const scaleFactor = Math.max(0.001, pointSize);
        scale.set(
          Math.max(0.0005, sx * scaleFactor),
          Math.max(0.0005, sy * scaleFactor),
          Math.max(0.0005, sz * scaleFactor)
        );
      } else {
        const fallback = Math.max(0.002, pointSize * 0.1);
        scale.set(fallback, fallback, fallback);
      }

      if (rot0 && rot1 && rot2 && rot3) {
        rotation.set(rot1.getX(index), rot2.getX(index), rot3.getX(index), rot0.getX(index)).normalize();
      } else {
        rotation.identity();
      }

      matrix.compose(translation, rotation, scale);
      mesh.setMatrixAt(cursor, matrix);
      if (color) {
        tempColor.setRGB(color.getX(index), color.getY(index), color.getZ(index));
      } else if (red && green && blue) {
        tempColor.setRGB(clamp01(red.getX(index) / 255), clamp01(green.getX(index) / 255), clamp01(blue.getX(index) / 255));
      } else if (fdc0 && fdc1 && fdc2) {
        tempColor.setRGB(
          clamp01(0.5 + SH_C0 * fdc0.getX(index)),
          clamp01(0.5 + SH_C0 * fdc1.getX(index)),
          clamp01(0.5 + SH_C0 * fdc2.getX(index))
        );
      } else {
        tempColor.setRGB(1, 1, 1);
      }

      if (opacityAttr) {
        const alpha = sigmoid(opacityAttr.getX(index));
        tempColor.multiplyScalar(Math.max(0.08, alpha));
      }

      if (mesh.instanceColor) {
        mesh.setColorAt(cursor, tempColor);
      }
      cursor += 1;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
    return mesh;
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

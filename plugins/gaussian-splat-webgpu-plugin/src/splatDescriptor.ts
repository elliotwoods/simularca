/**
 * Gaussian Splat actor descriptor for WebGPU rendering.
 * Phase 2: Loads PLY, builds GPU storage buffers, renders with TSL NodeMaterial.
 */

import * as THREE from "three";
import type { ReloadableDescriptor, ParameterSchema } from "./index";
import { SplatController } from "./splatController";

const DESCRIPTOR_ID = "plugin.gaussianSplat.webgpu";

const COORDINATE_CORRECTION_EULER = new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ");

const schema: ParameterSchema = {
  id: DESCRIPTOR_ID,
  title: "Gaussian Splat (WebGPU)",
  params: [
    {
      key: "assetId",
      label: "PLY Asset",
      type: "file",
      accept: [".ply"],
      dialogTitle: "Select Gaussian splat PLY",
      import: {
        mode: "import-asset",
        kind: "generic"
      }
    },
    {
      key: "scaleFactor",
      label: "Scale",
      type: "number",
      step: 0.001,
      precision: 3,
      defaultValue: 1
    },
    {
      key: "opacity",
      label: "Opacity",
      type: "number",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 1
    },
    {
      key: "brightness",
      label: "Brightness",
      type: "number",
      min: 0,
      max: 8,
      step: 0.05,
      defaultValue: 1
    },
    {
      key: "splatSizeScale",
      label: "Splat Size",
      type: "number",
      min: 0.1,
      max: 10,
      step: 0.05,
      precision: 2,
      defaultValue: 1
    },
    {
      key: "colorInputSpace",
      label: "Captured Color Space",
      type: "select",
      options: ["srgb", "iphone-sdr", "linear"],
      defaultValue: "srgb"
    }
  ]
};

interface GaussianSplatRuntime {
  assetId?: string;
  scaleFactor: number;
  opacity: number;
  brightness: number;
  splatSizeScale: number;
  colorInputSpace: string;
}

export function createGaussianSplatDescriptor(): ReloadableDescriptor {
  return {
    id: DESCRIPTOR_ID,
    kind: "actor",
    version: 1,
    schema,
    spawn: {
      actorType: "plugin",
      pluginType: DESCRIPTOR_ID,
      label: "Gaussian Splat (WebGPU)",
      description: "Renders imported PLY Gaussian splats using the WebGPU pipeline.",
      iconGlyph: "GW",
      fileExtensions: [".ply"]
    },
    createRuntime: ({ params }): GaussianSplatRuntime => ({
      assetId: typeof params.assetId === "string" ? params.assetId : undefined,
      scaleFactor: typeof params.scaleFactor === "number" ? params.scaleFactor : 1,
      opacity: typeof params.opacity === "number" ? params.opacity : 1,
      brightness: typeof params.brightness === "number" ? params.brightness : 1,
      splatSizeScale: typeof params.splatSizeScale === "number" ? params.splatSizeScale : 1,
      colorInputSpace: typeof params.colorInputSpace === "string" ? params.colorInputSpace : "srgb"
    }),
    updateRuntime(runtime: unknown, { params }) {
      const rt = runtime as GaussianSplatRuntime;
      rt.assetId = typeof params.assetId === "string" ? params.assetId : rt.assetId;
      rt.scaleFactor = typeof params.scaleFactor === "number" ? params.scaleFactor : rt.scaleFactor;
      rt.opacity = typeof params.opacity === "number" ? params.opacity : rt.opacity;
      rt.brightness = typeof params.brightness === "number" ? params.brightness : rt.brightness;
      rt.splatSizeScale = typeof params.splatSizeScale === "number" ? params.splatSizeScale : rt.splatSizeScale;
      rt.colorInputSpace = typeof params.colorInputSpace === "string" ? params.colorInputSpace : rt.colorInputSpace;
    },
    sceneHooks: {
      createObject() {
        const container = new THREE.Group();
        container.name = "gsplat-webgpu-container";
        const correctedRoot = new THREE.Group();
        correctedRoot.name = "gsplat-webgpu-render-root";
        correctedRoot.rotation.copy(COORDINATE_CORRECTION_EULER);
        container.add(correctedRoot);
        // Attach controller for load/render lifecycle
        container.userData.splatController = new SplatController(correctedRoot);
        return container;
      },
      syncObject(context) {
        const container = context.object as THREE.Group;
        const controller = container.userData.splatController as SplatController;
        if (controller) {
          const actor = context.actor as { id: string; params: Record<string, unknown> };
          controller.sync({
            actor,
            object: context.object,
            setActorStatus: context.setActorStatus,
            readAssetBytes: context.readAssetBytes
          });
        }
      },
      disposeObject({ object }) {
        const container = object as THREE.Group;
        const controller = container.userData.splatController as SplatController | undefined;
        if (controller) {
          controller.dispose();
          container.userData.splatController = undefined;
        }
        // Fallback: traverse and clean up any remaining geometry/material
        container.traverse((child: THREE.Object3D) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach(m => m.dispose());
            } else {
              mesh.material.dispose();
            }
          }
        });
      }
    },
    status: {
      build({ actor, runtimeStatus }) {
        const a = actor as { params: Record<string, unknown> };
        const rs = runtimeStatus as { values?: Record<string, unknown>; error?: string; updatedAtIso?: string } | undefined;
        return [
          { label: "Type", value: "Gaussian Splat (WebGPU)" },
          { label: "Backend", value: rs?.values?.backend ?? "webgpu-tsl" },
          { label: "Load State", value: rs?.values?.loadState ?? "n/a" },
          { label: "Point Count", value: rs?.values?.pointCount ?? "n/a" },
          {
            label: "Scale",
            value: typeof a.params.scaleFactor === "number" ? a.params.scaleFactor : 1
          },
          {
            label: "Opacity",
            value: typeof a.params.opacity === "number" ? a.params.opacity : 1
          },
          {
            label: "Brightness",
            value: typeof a.params.brightness === "number" ? a.params.brightness : 1
          },
          {
            label: "Splat Size",
            value: typeof a.params.splatSizeScale === "number" ? a.params.splatSizeScale : 1
          },
          { label: "Bounds Min (m)", value: rs?.values?.boundsMin ?? "n/a" },
          { label: "Bounds Max (m)", value: rs?.values?.boundsMax ?? "n/a" },
          { label: "Projection", value: rs?.values?.projectionPrepass ? "compute pre-pass" : "vertex shader" },
          { label: "Camera Near", value: rs?.values?.cameraNear ?? "n/a" },
          { label: "Sort Mode", value: rs?.values?.sortMode ?? "n/a" },
          { label: "Sort Dispatches", value: rs?.values?.sortDispatches ?? "n/a" },
          { label: "Frames Since Sort", value: rs?.values?.framesSinceFullSort ?? "n/a" },
          { label: "Sort Angle (rad)", value: rs?.values?.angleSinceSort ?? "n/a" },
          { label: "Visible Chunks", value: rs?.values?.visibleChunks ?? "n/a" },
          {
            label: "Last Update",
            value: rs?.updatedAtIso ? new Date(rs.updatedAtIso).toLocaleString() : "n/a"
          },
          { label: "Error", value: rs?.error ?? null, tone: "error" }
        ];
      }
    }
  };
}

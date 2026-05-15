import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  decimateMeshGlb,
  probeMeshGlbForDecimation,
  DecimationError,
  DecimationCanceledError,
  type DecimationProgress
} from "./meshDecimation";

async function buildCubeGlb(subdivisions: number): Promise<Uint8Array> {
  const geometry = new THREE.BoxGeometry(1, 1, 1, subdivisions, subdivisions, subdivisions);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const scene = new THREE.Scene();
  scene.add(mesh);
  const exporter = new GLTFExporter();
  return await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
        else reject(new Error("Expected GLB binary"));
      },
      (err) => reject(err),
      { binary: true }
    );
  });
}

describe("meshDecimation", () => {
  it("reduces triangle count on a dense cube", async () => {
    const sourceGlb = await buildCubeGlb(8);
    const probe = await probeMeshGlbForDecimation(sourceGlb, "glb");
    expect(probe.canDecimate).toBe(true);
    expect(probe.triangleCount).toBeGreaterThan(100);

    const results = await decimateMeshGlb(sourceGlb, { ratios: [0.5, 0.25], format: "glb" });
    expect(results).toHaveLength(2);
    expect(results[0]!.triangleCount).toBeLessThan(probe.triangleCount);
    expect(results[1]!.triangleCount).toBeLessThanOrEqual(results[0]!.triangleCount);
    expect(results[0]!.glbBytes.byteLength).toBeGreaterThan(0);
    expect(results[0]!.originalTriangleCount).toBe(probe.triangleCount);
  });

  it("rejects ratios outside (0, 1)", async () => {
    const sourceGlb = await buildCubeGlb(2);
    await expect(decimateMeshGlb(sourceGlb, { ratios: [1.5], format: "glb" })).rejects.toBeInstanceOf(DecimationError);
    await expect(decimateMeshGlb(sourceGlb, { ratios: [0], format: "glb" })).rejects.toBeInstanceOf(DecimationError);
    await expect(decimateMeshGlb(sourceGlb, { ratios: [], format: "glb" })).rejects.toBeInstanceOf(DecimationError);
  });

  it("emits progress for parse, decimate, and export stages", async () => {
    const sourceGlb = await buildCubeGlb(4);
    const stages = new Set<DecimationProgress["stage"]>();
    const progressEvents: DecimationProgress[] = [];
    await decimateMeshGlb(sourceGlb, {
      ratios: [0.5],
      format: "glb",
      onProgress: (p) => {
        stages.add(p.stage);
        progressEvents.push(p);
      }
    });
    expect(stages.has("parse")).toBe(true);
    expect(stages.has("decimate")).toBe(true);
    expect(stages.has("export")).toBe(true);
    // The final event should reach the announced total.
    const last = progressEvents[progressEvents.length - 1]!;
    expect(last.completed).toBe(last.total);
  });

  it("aborts when cancelToken.canceled is set mid-run", async () => {
    const sourceGlb = await buildCubeGlb(4);
    const cancelToken = { canceled: false };
    const promise = decimateMeshGlb(sourceGlb, {
      ratios: [0.5, 0.25, 0.1],
      format: "glb",
      cancelToken,
      onProgress: (p) => {
        // Trip the cancel flag the moment we see the first decimate event.
        if (p.stage === "decimate") {
          cancelToken.canceled = true;
        }
      }
    });
    await expect(promise).rejects.toBeInstanceOf(DecimationCanceledError);
  });
});

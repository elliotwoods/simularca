import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { mergeImportedSceneByMaterial } from "./meshMerge";

function box(material: THREE.Material, position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.set(...position);
  return mesh;
}

describe("mergeImportedSceneByMaterial", () => {
  it("merges same-material sub-meshes into one draw object", () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x336699 });
    root.add(box(mat, [0, 0, 0]), box(mat, [10, 0, 0]), box(mat, [0, 5, 0]));

    const result = mergeImportedSceneByMaterial(root);

    expect(result.merged).toBe(true);
    expect(result.beforeMeshCount).toBe(3);
    expect(result.afterMeshCount).toBe(1);
    const merged = result.object.children[0]! as THREE.Mesh;
    expect((merged.geometry as THREE.BufferGeometry).attributes.position!.count).toBe(24 * 3);
  });

  it("bakes world transforms into the merged geometry", () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial();
    root.add(box(mat, [0, 0, 0]), box(mat, [100, 0, 0]));

    const result = mergeImportedSceneByMaterial(root);
    const merged = result.object.children[0]! as THREE.Mesh;
    merged.geometry.computeBoundingBox();
    const bb = merged.geometry.boundingBox!;
    // First box spans [-0.5,0.5], second box baked at x=100 spans [99.5,100.5].
    expect(bb.min.x).toBeCloseTo(-0.5, 5);
    expect(bb.max.x).toBeCloseTo(100.5, 5);
  });

  it("keeps distinct materials as separate draw objects but dedupes identical ones", () => {
    const root = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    // Two separate-but-identical instances should dedupe into one bucket.
    const blueA = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const blueB = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    root.add(box(red, [0, 0, 0]), box(blueA, [2, 0, 0]), box(blueB, [4, 0, 0]));

    const result = mergeImportedSceneByMaterial(root);

    expect(result.merged).toBe(true);
    expect(result.afterMeshCount).toBe(2);
  });

  it("does not merge skinned meshes (returns original)", () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial();
    root.add(box(mat, [0, 0, 0]));
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), mat);
    root.add(skinned);

    const result = mergeImportedSceneByMaterial(root);

    expect(result.merged).toBe(false);
    expect(result.object).toBe(root);
  });

  it("does not merge a single mesh", () => {
    const root = new THREE.Group();
    root.add(box(new THREE.MeshStandardMaterial(), [0, 0, 0]));

    const result = mergeImportedSceneByMaterial(root);

    expect(result.merged).toBe(false);
  });
});

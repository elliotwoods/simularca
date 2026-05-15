import * as THREE from "three";

// Defensive walk that removes null/undefined children. Called every render frame
// over potentially huge scene graphs (the SSG Stadium FBX has ~10k Object3D
// nodes), so the inner loop must not allocate. The previous implementation
// spread `node.children` per-node, allocating thousands of small arrays per
// frame and contributing to GC-driven stalls during camera rotation.
export function pruneInvalidSceneGraph(root: THREE.Object3D): void {
  const stack: THREE.Object3D[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    const children = node.children;
    // Backwards iterate so splice indices stay correct. Push valid children
    // straight onto the stack — no intermediate copy of `children`.
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push(child);
      } else {
        children.splice(i, 1);
      }
    }
  }
}

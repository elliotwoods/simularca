import type { Object3D } from "three";

export const AO_MESH_LAYER = 1;

export function enableAOMeshLayer(root: Object3D | null | undefined): void {
  if (!root) {
    return;
  }
  root.traverse((object) => {
    object.layers.enable(AO_MESH_LAYER);
  });
}

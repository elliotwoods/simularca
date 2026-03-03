declare module "three/examples/jsm/controls/TransformControls.js" {
  import { Camera, Object3D } from "three";

  export class TransformControls extends Object3D {
    public camera: Camera;
    public object: Object3D | undefined;
    public size: number;
    public dragging: boolean;
    public constructor(camera: Camera, domElement: HTMLElement);
    public setMode(mode: "translate" | "rotate" | "scale"): void;
    public attach(object: Object3D): this;
    public detach(): this;
    public dispose(): void;
  }
}

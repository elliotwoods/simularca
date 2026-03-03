declare module "three" {
  const THREE: any;
  export = THREE;
}

declare module "three/examples/jsm/controls/OrbitControls.js" {
  export class OrbitControls {
    public object: any;
    public target: {
      x: number;
      y: number;
      z: number;
      set(x: number, y: number, z: number): void;
    };
    public enableDamping: boolean;
    public constructor(object: any, domElement?: HTMLElement);
    public update(): void;
    public dispose(): void;
  }
}

declare module "three/examples/jsm/loaders/PLYLoader.js" {
  export class PLYLoader {
    public setPropertyNameMapping(mapping: Record<string, string>): void;
    public setCustomPropertyNameMapping(mapping: Record<string, string[]>): void;
    public parse(data: ArrayBuffer | string): any;
    public load(
      url: string,
      onLoad: (geometry: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/RGBELoader.js" {
  export class RGBELoader {
    public load(
      url: string,
      onLoad: (texture: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/KTX2Loader.js" {
  export class KTX2Loader {
    public setTranscoderPath(path: string): this;
    public load(
      url: string,
      onLoad: (texture: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/GLTFLoader.js" {
  export class GLTFLoader {
    public load(
      url: string,
      onLoad: (result: { scene: any }) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/FBXLoader.js" {
  export class FBXLoader {
    public load(
      url: string,
      onLoad: (object: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/ColladaLoader.js" {
  export class ColladaLoader {
    public load(
      url: string,
      onLoad: (result: { scene: any }) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/examples/jsm/loaders/OBJLoader.js" {
  export class OBJLoader {
    public load(
      url: string,
      onLoad: (object: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}

declare module "three/webgpu" {
  export class WebGPURenderer {
    public domElement: HTMLCanvasElement;
    public info: {
      render: {
        calls: number;
        triangles: number;
      };
    };
    public constructor(parameters?: Record<string, unknown>);
    public setPixelRatio(value: number): void;
    public setSize(width: number, height: number): void;
    public render(scene: any, camera: any): void;
    public dispose(): void;
  }
  export class MeshBasicNodeMaterial {
    public color: any;
    public map: any;
    public alphaTest: number;
    public vertexColors: boolean;
    public transparent: boolean;
    public opacity: number;
    public depthTest: boolean;
    public depthWrite: boolean;
    public vertexNode: any;
    public needsUpdate: boolean;
    public constructor(parameters?: Record<string, unknown>);
  }
  export class SpriteNodeMaterial {
    public color: any;
    public map: any;
    public alphaTest: number;
    public vertexColors: boolean;
    public transparent: boolean;
    public opacity: number;
    public depthTest: boolean;
    public depthWrite: boolean;
    public positionNode: any;
    public scaleNode: any;
    public colorNode: any;
    public needsUpdate: boolean;
    public constructor(parameters?: Record<string, unknown>);
  }
}

declare module "three/tsl" {
  export function instancedBufferAttribute(attribute: any, type?: string): any;
  export function texture(value: any, uvNode?: any, levelNode?: any): any;
  export function vec4(x?: any, y?: any, z?: any, w?: any): any;
}

declare module "@mkkellogg/gaussian-splats-3d" {
  export const Viewer: new (...args: any[]) => any;
  const mod: any;
  export default mod;
}

declare module "@mkkellogg/gaussian-splats-3d/build/gaussian-splats-3d.module.js" {
  export const Viewer: new (...args: any[]) => any;
  const mod: any;
  export default mod;
}


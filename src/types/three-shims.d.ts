declare module "three/examples/jsm/controls/OrbitControls.js" {
  export class OrbitControls {
    public object: any;
    public target: import("three").Vector3;
    public enabled: boolean;
    public enableDamping: boolean;
    public minDistance: number;
    public maxDistance: number;
    public minZoom: number;
    public maxZoom: number;
    public constructor(object: any, domElement?: HTMLElement);
    public connect?(domElement: HTMLElement): void;
    public disconnect?(): void;
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
    public toneMapping: number;
    public outputColorSpace: string;
    public info: {
      render: {
        calls: number;
        triangles: number;
      };
    };
    public constructor(parameters?: Record<string, unknown>);
    public init?(): Promise<void>;
    public setPixelRatio(value: number): void;
    public setSize(width: number, height: number): void;
    public getRenderTarget?(): any;
    public setRenderTarget?(target: any | null): void;
    public readRenderTargetPixelsAsync?(
      target: any,
      x: number,
      y: number,
      width: number,
      height: number
    ): Promise<Uint8Array>;
    public renderAsync?(scene: any, camera: any): Promise<void>;
    public render(scene: any, camera: any): void;
    public dispose(): void;
  }
  export class PostProcessing {
    public outputNode: any;
    public outputColorTransform: boolean;
    public needsUpdate: boolean;
    public constructor(renderer: WebGPURenderer, outputNode?: any);
    public render(): void;
    public renderAsync?(): Promise<void>;
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
  export function clamp(value: any, min?: any, max?: any): any;
  export function dot(a: any, b: any): any;
  export function float(value?: any): any;
  export function fract(value: any): any;
  export function instancedBufferAttribute(attribute: any, type?: string): any;
  export function pass(scene: any, camera: any, options?: Record<string, unknown>): any;
  export function renderOutput(color: any, toneMapping?: any, outputColorSpace?: any): any;
  export const screenCoordinate: any;
  export function texture(value: any, uvNode?: any, levelNode?: any): any;
  export function vec2(x?: any, y?: any): any;
  export function vec3(x?: any, y?: any, z?: any): any;
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

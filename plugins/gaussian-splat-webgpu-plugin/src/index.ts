import { createGaussianSplatDescriptor } from "./splatDescriptor";
import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";

export interface ParameterSchema {
  id: string;
  title: string;
  params: Array<Record<string, unknown>>;
}

export interface ReloadableDescriptor {
  id: string;
  kind: "actor" | "component" | "system";
  version: number;
  schema: ParameterSchema;
  spawn?: {
    actorType: "plugin" | "empty" | "environment" | "gaussian-splat" | "mesh" | "primitive" | "curve";
    pluginType?: string;
    label?: string;
    description?: string;
    iconGlyph?: string;
    fileExtensions?: string[];
  };
  createRuntime(args: { params: Record<string, unknown> }): unknown;
  updateRuntime(runtime: unknown, args: { params: Record<string, unknown>; dtSeconds: number }): void;
  sceneHooks?: {
    createObject?(args: { actor: unknown; state: unknown }): unknown;
    syncObject?(context: {
      actor: unknown;
      state: unknown;
      object: unknown;
      simTimeSeconds: number;
      dtSeconds: number;
      getActorById(actorId: string): unknown | null;
      getActorObject(actorId: string): unknown | null;
      sampleCurveWorldPoint(actorId: string, t: number): { position: [number, number, number]; tangent: [number, number, number] } | null;
      profileChunk?<T>(label: string, run: () => T): T;
      setActorStatus(status: unknown): void;
      readAssetBytes(assetId: string): Promise<Uint8Array>;
    }): void;
    disposeObject?(args: { actor: unknown; state: unknown; object: unknown }): void;
  };
  status?: {
    build(context: { actor: unknown; state: unknown; runtimeStatus?: unknown }): Array<{ label: string; value: unknown; tone?: string }>;
  };
}

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
}

export interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  };
}

export interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinition;
}

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "gaussianSplat",
    name: "Gaussian Splat",
    version: PLUGIN_VERSION,
    description: "Renders Gaussian splats using the active scene render engine.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return {
      id: "gaussianSplat",
      name: "Gaussian Splat",
      actorDescriptors: [createGaussianSplatDescriptor()],
      componentDescriptors: []
    };
  }
};

export { handshake };
export default handshake;

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
    actorType: "plugin" | "empty" | "environment" | "gaussian-splat" | "gaussian-splat-spark" | "mesh" | "primitive" | "curve";
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
      setActorStatus(status: unknown): void;
    }): void;
    disposeObject?(args: { actor: unknown; state: unknown; object: unknown }): void;
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

const descriptorId = "plugin.template.artwork.actor";

const actorDescriptor: ReloadableDescriptor = {
  id: descriptorId,
  kind: "actor",
  version: 1,
  schema: {
    id: descriptorId,
    title: "Template Artwork Actor",
    params: []
  },
  spawn: {
    actorType: "plugin",
    pluginType: descriptorId,
    label: "Template Artwork Actor",
    description: "Template plugin actor with empty scene hook lifecycle.",
    iconGlyph: "TA"
  },
  createRuntime: () => ({ initializedAt: Date.now() }),
  updateRuntime: () => {
    // Intentionally empty template runtime update.
  },
  sceneHooks: {
    createObject: () => null,
    syncObject: () => {
      // Intentionally empty template scene sync.
    },
    disposeObject: () => {
      // Intentionally empty template scene dispose.
    }
  }
};

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "template.artwork.plugin",
    name: "Template Artwork Actor Plugin",
    version: "0.1.0",
    description: "Starter template for artwork-specific plugin actors.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return {
      id: "template.artwork.plugin",
      name: "Template Artwork Actor Plugin",
      actorDescriptors: [actorDescriptor],
      componentDescriptors: []
    };
  }
};

export { handshake };
export default handshake;

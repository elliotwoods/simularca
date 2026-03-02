export interface ParameterSchema {
  id: string;
  title: string;
  params: Array<{
    key: string;
    label: string;
    description?: string;
    type: "number" | "boolean" | "string" | "select" | "file";
    min?: number;
    max?: number;
    step?: number;
    precision?: number;
    unit?: string;
    dragSpeed?: number;
    options?: string[];
    accept?: string[];
    dialogTitle?: string;
    import?: {
      mode: "import-asset" | "transcode-hdri";
      kind?: "hdri" | "gaussian-splat" | "generic";
      options?: {
        uastc?: boolean;
        zstdLevel?: number;
        generateMipmaps?: boolean;
      };
    };
  }>;
}

export interface ReloadableDescriptor {
  id: string;
  kind: "actor" | "component" | "system";
  version: number;
  schema: ParameterSchema;
  createRuntime(args: { params: Record<string, number | string | boolean> }): unknown;
  updateRuntime(runtime: unknown, args: { params: Record<string, number | string | boolean>; dtSeconds: number }): void;
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

const waveActorSchema: ParameterSchema = {
  id: "plugin.wave.actor",
  title: "Wave Actor",
  params: [
    { key: "amplitude", label: "Amplitude", type: "number", min: 0, max: 5, step: 0.05 },
    { key: "frequency", label: "Frequency", type: "number", min: 0.1, max: 10, step: 0.1 }
  ]
};

const waveActorDescriptor: ReloadableDescriptor = {
  id: "plugin.wave.actor",
  kind: "actor",
  version: 1,
  schema: waveActorSchema,
  createRuntime: ({ params }) => ({
    phase: 0,
    amplitude: typeof params.amplitude === "number" ? params.amplitude : 1,
    frequency: typeof params.frequency === "number" ? params.frequency : 1
  }),
  updateRuntime: (runtime, { params, dtSeconds }) => {
    const typed = runtime as { phase: number; amplitude: number; frequency: number };
    typed.amplitude = typeof params.amplitude === "number" ? params.amplitude : typed.amplitude;
    typed.frequency = typeof params.frequency === "number" ? params.frequency : typed.frequency;
    typed.phase += typed.frequency * dtSeconds;
  }
};

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "example.wave",
    name: "Example Wave Plugin",
    version: "0.1.0",
    description: "Reference plugin demonstrating handshake contract and actor registration.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return {
      id: "example.wave",
      name: "Example Wave Plugin",
      actorDescriptors: [waveActorDescriptor],
      componentDescriptors: []
    };
  }
};

export { handshake };
export default handshake;

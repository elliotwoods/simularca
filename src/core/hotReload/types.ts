import type { ActorType, ParameterSchema, ParameterValues } from "@/core/types";

export type DescriptorKind = "actor" | "component" | "system";

export interface ParamMigration {
  fromVersion: number;
  toVersion: number;
  migrate(params: ParameterValues): ParameterValues;
}

export interface ReloadableDescriptor<TRuntime = unknown> {
  id: string;
  kind: DescriptorKind;
  version: number;
  schema: ParameterSchema;
  spawn?: {
    actorType: ActorType;
    pluginType?: string;
    label?: string;
    description?: string;
    iconGlyph?: string;
  };
  createRuntime(args: { params: ParameterValues }): TRuntime;
  updateRuntime(runtime: TRuntime, args: { params: ParameterValues; dtSeconds: number }): void;
  disposeRuntime?(runtime: TRuntime): void;
  migrations?: ParamMigration[];
}

export interface RuntimeInstanceHandle<TRuntime = unknown> {
  instanceId: string;
  descriptorId: string;
  runtime: TRuntime;
  status: "running" | "rebuilding" | "disposed";
}

export interface HotReloadEvent {
  moduleId: string;
  changeType: "added" | "replaced" | "removed";
  applied: boolean;
  fallbackReason?: string;
}


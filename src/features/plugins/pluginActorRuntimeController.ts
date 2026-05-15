import type { ActorRuntimeStatus, ActorNode, AppState, VolumetricRayFieldResource } from "@/core/types";
import type { ReloadableDescriptor, RuntimeInstanceHandle } from "@/core/hotReload/types";
import type { ActorProfilingService } from "@/render/profiling";

interface ManagedRuntimeHandle extends RuntimeInstanceHandle {
  descriptor: ReloadableDescriptor;
  descriptorKey: string;
}

interface RuntimeStatusCarrier {
  getRuntimeStatus?(): ActorRuntimeStatus | null;
  runtimeStatus?: ActorRuntimeStatus | null;
}

interface VolumetricResourceCarrier {
  getVolumetricResource?(): VolumetricRayFieldResource | null;
  volumetricResource?: VolumetricRayFieldResource | null;
}

export interface PluginActorRuntimeControllerOptions {
  resolveDescriptor(actor: ActorNode): ReloadableDescriptor | null | undefined;
  isActorPluginEnabled?(actor: ActorNode): boolean;
  setActorStatus(actorId: string, status: ActorRuntimeStatus | null): void;
  addLog?(entry: { level: "warn" | "error"; message: string; details?: string }): void;
  profiler?: ActorProfilingService;
}

function descriptorKey(descriptor: ReloadableDescriptor): string {
  return `${descriptor.id}@${String(descriptor.version)}`;
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function readRuntimeStatus(runtime: unknown): ActorRuntimeStatus | null | undefined {
  if (!runtime || typeof runtime !== "object") {
    return undefined;
  }
  const candidate = runtime as RuntimeStatusCarrier;
  if (typeof candidate.getRuntimeStatus === "function") {
    return candidate.getRuntimeStatus();
  }
  if ("runtimeStatus" in candidate) {
    return candidate.runtimeStatus ?? null;
  }
  return undefined;
}

function readVolumetricResource(runtime: unknown): VolumetricRayFieldResource | null | undefined {
  if (!runtime || typeof runtime !== "object") {
    return undefined;
  }
  const candidate = runtime as VolumetricResourceCarrier;
  if (typeof candidate.getVolumetricResource === "function") {
    return candidate.getVolumetricResource();
  }
  if ("volumetricResource" in candidate) {
    return candidate.volumetricResource ?? null;
  }
  return undefined;
}

export class PluginActorRuntimeController {
  private readonly handles = new Map<string, ManagedRuntimeHandle>();

  public constructor(private readonly options: PluginActorRuntimeControllerOptions) {}

  public sync(state: AppState, dtSeconds: number): void {
    const pluginActors = Object.values(state.actors).filter((actor) => actor.actorType === "plugin");
    const activeActorIds = new Set(pluginActors.map((actor) => actor.id));

    for (const actorId of [...this.handles.keys()]) {
      if (!activeActorIds.has(actorId)) {
        this.disposeHandle(actorId);
      }
    }

    for (const actor of pluginActors) {
      if (this.options.isActorPluginEnabled && !this.options.isActorPluginEnabled(actor)) {
        this.disposeHandle(actor.id);
        continue;
      }
      const descriptor = this.options.resolveDescriptor(actor);
      if (!descriptor) {
        this.disposeHandle(actor.id);
        continue;
      }

      const nextDescriptorKey = descriptorKey(descriptor);
      let handle = this.handles.get(actor.id);
      if (!handle || handle.descriptorKey !== nextDescriptorKey) {
        this.disposeHandle(actor.id);
        handle = this.createHandle(actor, descriptor, nextDescriptorKey);
      }
      if (!handle) {
        continue;
      }

      try {
        const updateRuntime = () =>
          descriptor.updateRuntime(handle.runtime, {
            params: actor.params,
            dtSeconds
          });
        if (this.options.profiler?.shouldProfileUpdates()) {
          this.options.profiler.withActorPhase(
            {
              actorId: actor.id,
              actorName: actor.name,
              actorType: actor.actorType,
              pluginType: actor.pluginType
            },
            "update",
            () =>
              this.options.profiler?.getDetailPreset() === "standard"
                ? this.options.profiler.withChunk("Runtime update", updateRuntime)
                : updateRuntime()
          );
        } else {
          updateRuntime();
        }
        handle.status = "running";
        const runtimeStatus = readRuntimeStatus(handle.runtime);
        if (runtimeStatus !== undefined) {
          this.options.setActorStatus(actor.id, runtimeStatus);
        }
      } catch (error) {
        this.options.setActorStatus(actor.id, {
          values: {},
          error: `Plugin runtime update failed: ${formatRuntimeError(error)}`,
          updatedAtIso: new Date().toISOString()
        });
      }
    }
  }

  public getRuntime<TRuntime = unknown>(actorId: string): TRuntime | null {
    return (this.handles.get(actorId)?.runtime as TRuntime | undefined) ?? null;
  }

  public getVolumetricResource(actorId: string): VolumetricRayFieldResource | null {
    const runtime = this.handles.get(actorId)?.runtime;
    const resource = readVolumetricResource(runtime);
    return resource ?? null;
  }

  public dispose(): void {
    for (const actorId of [...this.handles.keys()]) {
      this.disposeHandle(actorId);
    }
  }

  private createHandle(
    actor: ActorNode,
    descriptor: ReloadableDescriptor,
    nextDescriptorKey: string
  ): ManagedRuntimeHandle | undefined {
    try {
      const runtime = descriptor.createRuntime({
        params: actor.params
      });
      const handle: ManagedRuntimeHandle = {
        instanceId: actor.id,
        descriptorId: descriptor.id,
        descriptor,
        descriptorKey: nextDescriptorKey,
        runtime,
        status: "running"
      };
      this.handles.set(actor.id, handle);
      const runtimeStatus = readRuntimeStatus(runtime);
      if (runtimeStatus !== undefined) {
        this.options.setActorStatus(actor.id, runtimeStatus);
      }
      return handle;
    } catch (error) {
      this.options.setActorStatus(actor.id, {
        values: {},
        error: `Plugin runtime create failed: ${formatRuntimeError(error)}`,
        updatedAtIso: new Date().toISOString()
      });
      return undefined;
    }
  }

  private disposeHandle(actorId: string): void {
    const handle = this.handles.get(actorId);
    if (!handle) {
      return;
    }
    handle.status = "disposed";
    try {
      handle.descriptor.disposeRuntime?.(handle.runtime);
    } catch (error) {
      this.options.addLog?.({
        level: "warn",
        message: `Plugin runtime dispose failed for ${handle.descriptorId}`,
        details: formatRuntimeError(error)
      });
    }
    this.handles.delete(actorId);
  }
}

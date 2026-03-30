import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "@/core/defaults";
import type { ActorNode, ActorRuntimeStatus, VolumetricRayFieldResource } from "@/core/types";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { PluginActorRuntimeController } from "@/features/plugins/pluginActorRuntimeController";

function createPluginActor(params: ActorNode["params"] = {}): ActorNode {
  return {
    id: "actor.plugin",
    name: "Plugin Actor",
    enabled: true,
    kind: "actor",
    actorType: "plugin",
    pluginType: "plugin.fake.actor",
    visibilityMode: "visible",
    parentActorId: null,
    childActorIds: [],
    componentIds: [],
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params
  };
}

function createDescriptor(disposeSpy?: () => void): ReloadableDescriptor<{
  ticks: number;
  runtimeStatus: ActorRuntimeStatus | null;
  volumetricResource: VolumetricRayFieldResource;
}> {
  return {
    id: "plugin.fake.actor",
    kind: "actor",
    version: 1,
    schema: {
      id: "plugin.fake.actor",
      title: "Fake Plugin Actor",
      params: []
    },
    spawn: {
      actorType: "plugin",
      pluginType: "plugin.fake.actor",
      label: "Fake Plugin Actor"
    },
    createRuntime() {
      return {
        ticks: 0,
        runtimeStatus: {
          values: {
            ready: true,
            tickCount: 0
          },
          updatedAtIso: "2026-01-01T00:00:00.000Z"
        },
        volumetricResource: {
          kind: "ray-field",
          segments: [
            {
              start: [0, 0, 0],
              end: [0, 0, 1],
              direction: [0, 0, 1],
              length: 1,
              weight: 0.75
            }
          ],
          hitPoints: [[0, 0, 1]],
          suggestedSampleSpacingMeters: 0.25,
          suggestedMaxSamples: 32
        }
      };
    },
    updateRuntime(runtime) {
      runtime.ticks += 1;
      runtime.runtimeStatus = {
        values: {
          ready: true,
          tickCount: runtime.ticks
        },
        updatedAtIso: `2026-01-01T00:00:0${String(runtime.ticks)}.000Z`
      };
    },
    disposeRuntime() {
      disposeSpy?.();
    }
  };
}

describe("PluginActorRuntimeController", () => {
  it("creates runtimes, forwards runtime status, and exposes volumetric resources", () => {
    const statusSpy = vi.fn();
    const descriptor = createDescriptor();
    const controller = new PluginActorRuntimeController({
      resolveDescriptor: () => descriptor,
      setActorStatus: statusSpy
    });
    const state = createInitialState("electron-rw");
    state.actors = {
      "actor.plugin": createPluginActor()
    };

    controller.sync(state, 1 / 60);

    expect(statusSpy).toHaveBeenCalled();
    expect(controller.getRuntime("actor.plugin")).toBeTruthy();
    expect(controller.getVolumetricResource("actor.plugin")).toEqual({
      kind: "ray-field",
      segments: [
        {
          start: [0, 0, 0],
          end: [0, 0, 1],
          direction: [0, 0, 1],
          length: 1,
          weight: 0.75
        }
      ],
      hitPoints: [[0, 0, 1]],
      suggestedSampleSpacingMeters: 0.25,
      suggestedMaxSamples: 32
    });
  });

  it("disposes stale runtimes when plugin actors disappear", () => {
    const disposeSpy = vi.fn();
    const descriptor = createDescriptor(disposeSpy);
    const controller = new PluginActorRuntimeController({
      resolveDescriptor: () => descriptor,
      setActorStatus: vi.fn()
    });
    const state = createInitialState("electron-rw");
    state.actors = {
      "actor.plugin": createPluginActor()
    };

    controller.sync(state, 1 / 60);
    state.actors = {};
    controller.sync(state, 1 / 60);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(controller.getRuntime("actor.plugin")).toBeNull();
    expect(controller.getVolumetricResource("actor.plugin")).toBeNull();
  });
});

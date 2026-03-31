import { describe, expect, test } from "vitest";
import type { ActorNode, ActorRuntimeStatus, AppState } from "@/core/types";
import { createInitialState } from "@/core/defaults";
import { environmentProbeActorDescriptor } from "@/features/actors/descriptors/environmentProbeActor";

function createActor(overrides: Partial<ActorNode> = {}): ActorNode {
  return {
    id: "actor.probe",
    name: "Probe",
    enabled: true,
    kind: "actor",
    actorType: "environment-probe",
    visibilityMode: "visible",
    pluginType: undefined,
    parentActorId: null,
    childActorIds: [],
    componentIds: [],
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params: {
      actorIds: ["actor.a", "actor.b"],
      resolution: 256,
      preview: "sphere",
      renderMode: "on-change"
    },
    ...overrides
  };
}

function createState(): AppState {
  const state = createInitialState("electron-rw", "test", "main");
  state.scene.renderEngine = "webgpu";
  return state;
}

describe("environmentProbeActorDescriptor", () => {
  test("falls back legacy none preview values to sphere", () => {
    const legacyActor = createActor({
      params: {
        actorIds: [],
        resolution: 256,
        preview: "none",
        renderMode: "on-change"
      }
    });
    const runtime = environmentProbeActorDescriptor.createRuntime({
      params: legacyActor.params
    });

    expect(runtime.preview).toBe("sphere");
  });

  test("reports captured and skipped actors and surfaces warnings", () => {
    const actor = createActor();
    const runtimeStatus: ActorRuntimeStatus = {
      values: {
        loadState: "captured",
        capturedActorCount: 1,
        skippedActorCount: 1,
        warning: "Environment probe skipped 1 actors. Mist: Mist Volume actor currently requires WebGL2."
      },
      updatedAtIso: new Date().toISOString()
    };

    const rows = environmentProbeActorDescriptor.status?.build({
      actor,
      state: createState(),
      runtimeStatus
    });

    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Captured Actors", value: 1 },
        { label: "Selected Actors", value: 2 },
        { label: "Skipped Actors", value: 1 },
        {
          label: "Warning",
          value: "Environment probe skipped 1 actors. Mist: Mist Volume actor currently requires WebGL2.",
          tone: "warning"
        }
      ])
    );
  });
});

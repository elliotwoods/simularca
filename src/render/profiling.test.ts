import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ActorProfilingService, buildProfileConsoleSummary } from "@/render/profiling";

describe("ActorProfilingService", () => {
  it("captures nested update chunks into a completed result", async () => {
    const service = new ActorProfilingService();
    service.startCapture({
      frameCount: 1,
      includeUpdateTimings: true,
      includeDrawTimings: false,
      includeGpuTimings: false,
      detailPreset: "standard"
    });

    service.beginFrame();
    await service.withActorPhase(
      {
        actorId: "actor-1",
        actorName: "Beam Emitter Array",
        actorType: "plugin",
        pluginType: "plugin.beamCrossover.emitterArray"
      },
      "update",
      () =>
        service.withChunk("Mesh silhouette solve", () => {
          service.withChunk("Chain assembly", () => {});
        })
    );
    service.finishFrame({ cpuTotalDurationMs: 16.7 });

    const state = service.getState();
    expect(state.phase).toBe("completed");
    expect(state.result?.frames).toHaveLength(1);
    expect(state.result?.frames[0]?.actors[0]?.update?.children[0]?.label).toBe("Mesh silhouette solve");
    expect(state.result?.frames[0]?.actors[0]?.update?.children[0]?.children[0]?.label).toBe("Chain assembly");
    expect(state.result?.summary.cpu.averageFrameMs).toBe(16.7);
  });

  it("mirrors nested actor chunks into the frame graph", async () => {
    const service = new ActorProfilingService();
    service.startCapture({
      frameCount: 1,
      includeUpdateTimings: true,
      includeDrawTimings: false,
      includeGpuTimings: false,
      detailPreset: "standard"
    });

    service.beginFrame();
    await service.withFrameChunk("Actor update loop", async () => {
      await service.withActorPhase(
        {
          actorId: "actor-1",
          actorName: "Beam Emitter Array",
          actorType: "plugin",
          pluginType: "plugin.beamCrossover.emitterArray"
        },
        "update",
        () =>
          service.withChunk("Emitter sampling + placement assembly", () => {
            service.withChunk("Mesh silhouette solve", () => {});
          })
      );
    });
    service.finishFrame({ cpuTotalDurationMs: 10 });

    const frameRoots = service.getLatestResult()?.frames[0]?.cpu.roots ?? [];
    const actorUpdateRoot = frameRoots.find((root) => root.label === "Actor update loop");
    const actorMirror = actorUpdateRoot?.children.find((child) => child.label === "Beam Emitter Array");
    expect(actorMirror?.children.map((child) => child.label)).toContain("Emitter sampling + placement assembly");
    expect(actorMirror?.children[0]?.children.map((child) => child.label)).toContain("Mesh silhouette solve");
  });

  it("records nested draw chunks inside mirrored frame nodes", () => {
    const service = new ActorProfilingService();
    service.startCapture({
      frameCount: 1,
      includeUpdateTimings: false,
      includeDrawTimings: true,
      includeGpuTimings: false,
      detailPreset: "standard"
    });

    service.beginFrame();
    service.withFrameChunk("Render submission", () => {
      service.beginDrawSample(
        {
          actorId: "actor-2",
          actorName: "Gaussian Splat",
          actorType: "plugin",
          pluginType: "plugin.gaussianSplat"
        },
        "draw-1"
      );
      service.withChunk("GPU sort dispatch", () => {});
      service.withChunk("Projection compute dispatch", () => {});
      service.endDrawSample(
        {
          actorId: "actor-2",
          actorName: "Gaussian Splat",
          actorType: "plugin",
          pluginType: "plugin.gaussianSplat"
        },
        "draw-1"
      );
    });
    service.finishFrame({ cpuTotalDurationMs: 9.5 });

    const frameRoots = service.getLatestResult()?.frames[0]?.cpu.roots ?? [];
    const renderRoot = frameRoots.find((root) => root.label === "Render submission");
    const actorMirror = renderRoot?.children.find((child) => child.label === "Gaussian Splat");
    expect(actorMirror?.children.map((child) => child.label)).toEqual(
      expect.arrayContaining(["GPU sort dispatch", "Projection compute dispatch"])
    );
  });

  it("wraps draw callbacks temporarily and restores originals when cleared", () => {
    const service = new ActorProfilingService();
    service.startCapture({
      frameCount: 2,
      includeUpdateTimings: false,
      includeDrawTimings: true,
      includeGpuTimings: false,
      detailPreset: "minimal"
    });
    service.beginFrame();

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const beforeSpy = vi.fn();
    const afterSpy = vi.fn();
    mesh.onBeforeRender = beforeSpy;
    mesh.onAfterRender = afterSpy;

    service.syncDrawHooks([
      {
        actor: {
          actorId: "actor-2",
          actorName: "Primitive",
          actorType: "primitive"
        },
        object: mesh
      }
    ]);

    const wrappedBefore = mesh.onBeforeRender;
    const wrappedAfter = mesh.onAfterRender;
    expect(wrappedBefore).not.toBe(beforeSpy);
    expect(wrappedAfter).not.toBe(afterSpy);

    wrappedBefore?.call(mesh, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    wrappedAfter?.call(mesh, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expect(beforeSpy).toHaveBeenCalledTimes(1);
    expect(afterSpy).toHaveBeenCalledTimes(1);

    service.clearDrawHooks();
    expect(mesh.onBeforeRender).toBe(beforeSpy);
    expect(mesh.onAfterRender).toBe(afterSpy);
  });

  it("builds an LLM-readable console summary with worst frames and hot plugins", () => {
    const service = new ActorProfilingService();
    service.startCapture({
      frameCount: 1,
      includeUpdateTimings: true,
      includeDrawTimings: false,
      includeGpuTimings: true,
      detailPreset: "standard"
    });

    service.beginFrame();
    service.withFrameChunk("Scene sync", () => {
      service.withActorPhase(
        {
          actorId: "actor-3",
          actorName: "Gaussian Splat",
          actorType: "plugin",
          pluginType: "plugin.gaussianSplat"
        },
        "update",
        () => {
          service.withChunk("Uniform update", () => {});
        }
      );
    });
    service.finishFrame({
      cpuTotalDurationMs: 12.5,
      gpu: {
        status: "captured",
        roots: [
          {
            id: "gpu:render",
            label: "Render",
            durationMs: 4.5,
            children: []
          },
          {
            id: "gpu:compute",
            label: "Compute",
            durationMs: 1.25,
            children: []
          }
        ]
      }
    });

    const summary = buildProfileConsoleSummary(service.getLatestResult());
    expect(summary).not.toBeNull();
    expect((summary as { survey?: { cpu?: { worstFrame?: { frameIndex?: number } } } }).survey?.cpu?.worstFrame?.frameIndex).toBe(0);
    expect((summary as { survey?: { hotPlugins?: Array<{ pluginType: string }> } }).survey?.hotPlugins?.[0]?.pluginType).toBe(
      "plugin.gaussianSplat"
    );
  });
});

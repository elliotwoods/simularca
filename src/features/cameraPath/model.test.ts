import { describe, expect, it } from "vitest";
import type { ActorNode } from "@/core/types";
import {
  appendCameraPathCurvePoint,
  buildSinglePointCurveData,
  clampCameraPathKeyframeTime,
  getCameraPathDurationSeconds,
  getCameraPathKeyframes,
  sampleCameraPathPoseAtTime
} from "@/features/cameraPath/model";

function createActor(input: Partial<ActorNode> & Pick<ActorNode, "id" | "actorType" | "name">): ActorNode {
  return {
    id: input.id,
    name: input.name,
    enabled: true,
    kind: "actor",
    actorType: input.actorType,
    visibilityMode: "visible",
    parentActorId: input.parentActorId ?? null,
    childActorIds: input.childActorIds ?? [],
    componentIds: [],
    transform: input.transform ?? {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1]
    },
    params: input.params ?? {}
  };
}

describe("cameraPath model", () => {
  it("seeds managed camera curves with auto anchors", () => {
    expect(buildSinglePointCurveData([5, 6, 7])).toMatchObject({
      closed: false,
      points: [
        {
          position: [5, 6, 7],
          mode: "auto",
          handleInMode: "normal",
          handleOutMode: "normal",
          enabled: true
        }
      ]
    });
  });

  it("appends camera path keyframes with neighbor-aware anchors", () => {
    const curveActor = createActor({
      id: "position",
      actorType: "curve",
      name: "camera position",
      params: {
        curveData: buildSinglePointCurveData([0, 0, 0])
      }
    });

    expect(appendCameraPathCurvePoint(curveActor, [1, 2, 3])).toMatchObject({
      points: [
        { position: [0, 0, 0], mode: "auto" },
        {
          position: [1, 2, 3],
          mode: "auto",
          handleInMode: "normal",
          handleOutMode: "normal",
          enabled: true
        }
      ]
    });
  });

  it("creates fallback explicit keyframes from managed curve counts", () => {
    const cameraPath = createActor({
      id: "path",
      actorType: "camera-path",
      name: "Camera Path",
      params: {
        positionCurveActorId: "position",
        targetCurveActorId: "target",
        targetMode: "curve"
      }
    });
    const positionCurve = createActor({
      id: "position",
      actorType: "curve",
      name: "camera position",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [1, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });
    const targetCurve = createActor({
      id: "target",
      actorType: "curve",
      name: "camera target",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [0, 0, 2], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });

    const keyframes = getCameraPathKeyframes(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve
    });

    expect(keyframes).toHaveLength(2);
    expect(keyframes[0]?.timeSeconds).toBe(0);
    expect(keyframes[1]?.timeSeconds).toBe(1);
  });

  it("samples curve-target camera paths from explicit times", () => {
    const cameraPath = createActor({
      id: "path",
      actorType: "camera-path",
      name: "Camera Path",
      params: {
        positionCurveActorId: "position",
        targetCurveActorId: "target",
        targetMode: "curve",
        keyframes: [
          { id: "kf0", timeSeconds: 0 },
          { id: "kf1", timeSeconds: 2 }
        ]
      }
    });
    const positionCurve = createActor({
      id: "position",
      actorType: "curve",
      name: "camera position",
      parentActorId: "path",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [10, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });
    const targetCurve = createActor({
      id: "target",
      actorType: "curve",
      name: "camera target",
      parentActorId: "path",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [0, 5, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });

    const pose = sampleCameraPathPoseAtTime(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve
    }, 1);

    expect(pose).toEqual({
      position: [5, 0, 0],
      target: [0, 2.5, 1]
    });
  });

  it("samples actor-target camera paths using the target actor origin and clamps after duration", () => {
    const cameraPath = createActor({
      id: "path",
      actorType: "camera-path",
      name: "Camera Path",
      params: {
        positionCurveActorId: "position",
        targetCurveActorId: "target-curve",
        targetMode: "actor",
        targetActorId: "target-actor",
        keyframes: [
          { id: "kf0", timeSeconds: 0 },
          { id: "kf1", timeSeconds: 3 }
        ]
      }
    });
    const positionCurve = createActor({
      id: "position",
      actorType: "curve",
      name: "camera position",
      parentActorId: "path",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [9, 8, 7], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });
    const targetCurve = createActor({
      id: "target-curve",
      actorType: "curve",
      name: "camera target",
      parentActorId: "path",
      params: {
        curveData: {
          closed: false,
          points: [
            { position: [0, 0, 0], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [1, 1, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });
    const targetActor = createActor({
      id: "target-actor",
      actorType: "empty",
      name: "Target",
      transform: {
        position: [3, 4, 5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      }
    });

    const pose = sampleCameraPathPoseAtTime(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve,
      [targetActor.id]: targetActor
    }, 10);

    expect(pose).toEqual({
      position: [9, 8, 7],
      target: [3, 4, 5]
    });
    expect(getCameraPathDurationSeconds(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve,
      [targetActor.id]: targetActor
    })).toBe(3);
  });

  it("uses explicit keyframes for playback when a referenced curve is analytic circle", () => {
    const cameraPath = createActor({
      id: "path",
      actorType: "camera-path",
      name: "Camera Path",
      params: {
        positionCurveActorId: "position",
        targetCurveActorId: "target",
        targetMode: "curve",
        keyframes: [
          { id: "kf0", timeSeconds: 0 },
          { id: "kf1", timeSeconds: 4 }
        ]
      }
    });
    const positionCurve = createActor({
      id: "position",
      actorType: "curve",
      name: "circle path",
      params: {
        curveType: "circle",
        radius: 2
      }
    });
    const targetCurve = createActor({
      id: "target",
      actorType: "curve",
      name: "target curve",
      params: {
        curveData: {
          kind: "spline",
          closed: false,
          points: [
            { position: [0, 0, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" },
            { position: [0, 2, 1], handleIn: [0, 0, 0], handleOut: [0, 0, 0], mode: "mirrored" }
          ]
        }
      }
    });

    const keyframes = getCameraPathKeyframes(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve
    });
    expect(keyframes).toHaveLength(2);

    const pose = sampleCameraPathPoseAtTime(cameraPath, {
      [cameraPath.id]: cameraPath,
      [positionCurve.id]: positionCurve,
      [targetCurve.id]: targetCurve
    }, 2);

    expect(pose?.position[0]).toBeCloseTo(-2, 6);
    expect(pose?.position[1]).toBeCloseTo(0, 6);
    expect(pose?.target).toEqual([0, 1, 1]);
  });

  it("clamps retimed keyframes between their neighbors", () => {
    const clamped = clampCameraPathKeyframeTime([
      { id: "kf0", timeSeconds: 0 },
      { id: "kf1", timeSeconds: 2 },
      { id: "kf2", timeSeconds: 4 }
    ], 1, 10);
    expect(clamped).toBeCloseTo(3.99, 6);
  });
});

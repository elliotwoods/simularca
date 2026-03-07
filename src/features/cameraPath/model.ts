import * as THREE from "three";
import { createId } from "@/core/ids";
import type { ActorNode } from "@/core/types";
import { curveDataWithOverrides, getCurveTypeFromActor } from "@/features/curves/model";
import { sampleCurvePositionAndTangent } from "@/features/curves/sampler";

export interface CameraPathKeyframe {
  id: string;
  timeSeconds: number;
}

export interface CameraPathRefs {
  positionCurveActor: ActorNode | null;
  targetCurveActor: ActorNode | null;
  targetMode: "curve" | "actor";
  targetActor: ActorNode | null;
}

export interface CameraPathPose {
  position: [number, number, number];
  target: [number, number, number];
}

const CAMERA_PATH_KEYFRAME_EPSILON_SECONDS = 0.01;

function getCameraPathTargetMode(value: unknown): "curve" | "actor" {
  return value === "actor" ? "actor" : "curve";
}

function toFiniteTimeSeconds(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, raw);
}

function getSharedManagedCurveCount(refs: CameraPathRefs): number {
  const positionCount =
    refs.positionCurveActor && getCurveTypeFromActor(refs.positionCurveActor) === "spline"
      ? curveDataWithOverrides(refs.positionCurveActor).points.length
      : 0;
  if (refs.targetMode === "actor") {
    return positionCount;
  }
  const targetCount =
    refs.targetCurveActor && getCurveTypeFromActor(refs.targetCurveActor) === "spline"
      ? curveDataWithOverrides(refs.targetCurveActor).points.length
      : 0;
  return Math.min(positionCount, targetCount);
}

export function createCameraPathKeyframe(timeSeconds: number): CameraPathKeyframe {
  return {
    id: createId("camkf"),
    timeSeconds: Math.max(0, timeSeconds)
  };
}

export function buildDefaultCameraPathKeyframes(count: number): CameraPathKeyframe[] {
  const safeCount = Math.max(0, Math.floor(count));
  return Array.from({ length: safeCount }, (_, index) =>
    createCameraPathKeyframe(index === 0 ? 0 : index)
  );
}

export function resolveCameraPathRefs(cameraPathActor: ActorNode, actors: Record<string, ActorNode>): CameraPathRefs {
  const positionCurveActorId =
    typeof cameraPathActor.params.positionCurveActorId === "string" ? cameraPathActor.params.positionCurveActorId : "";
  const targetCurveActorId =
    typeof cameraPathActor.params.targetCurveActorId === "string" ? cameraPathActor.params.targetCurveActorId : "";
  const targetActorId = typeof cameraPathActor.params.targetActorId === "string" ? cameraPathActor.params.targetActorId : "";
  const positionCurveActor = actors[positionCurveActorId];
  const targetCurveActor = actors[targetCurveActorId];
  const targetActor = actors[targetActorId];
  return {
    positionCurveActor: positionCurveActor?.actorType === "curve" ? positionCurveActor : null,
    targetCurveActor: targetCurveActor?.actorType === "curve" ? targetCurveActor : null,
    targetMode: getCameraPathTargetMode(cameraPathActor.params.targetMode),
    targetActor: targetActor ?? null
  };
}

export function getCameraPathKeyframes(cameraPathActor: ActorNode, actors: Record<string, ActorNode>): CameraPathKeyframe[] {
  const refs = resolveCameraPathRefs(cameraPathActor, actors);
  const expectedCount = getSharedManagedCurveCount(refs);
  const source = Array.isArray(cameraPathActor.params.keyframes)
    ? cameraPathActor.params.keyframes
    : [];
  const explicitCount = source.length;
  const resolvedCount = expectedCount > 0 ? expectedCount : explicitCount;
  if (resolvedCount <= 0) {
    return [];
  }
  const keyframes: CameraPathKeyframe[] = [];
  for (let index = 0; index < resolvedCount; index += 1) {
    const raw = source[index];
    const previous = keyframes[index - 1];
    const fallbackTime = index === 0 ? 0 : (previous?.timeSeconds ?? index - 1) + 1;
    if (!raw || typeof raw !== "object") {
      keyframes.push({
        id: `camera-path-keyframe-${String(index + 1)}`,
        timeSeconds: fallbackTime
      });
      continue;
    }
    const candidate = raw as { id?: unknown; timeSeconds?: unknown };
    keyframes.push({
      id: typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id
        : `camera-path-keyframe-${String(index + 1)}`,
      timeSeconds: toFiniteTimeSeconds(candidate.timeSeconds, fallbackTime)
    });
  }

  for (let index = 0; index < keyframes.length; index += 1) {
    if (index === 0) {
      const current = keyframes[index];
      if (!current) {
        continue;
      }
      keyframes[index] = { id: current.id, timeSeconds: 0 };
      continue;
    }
    const previous = keyframes[index - 1];
    const current = keyframes[index];
    if (!previous || !current) {
      continue;
    }
    keyframes[index] = {
      id: current.id,
      timeSeconds: Math.max(previous.timeSeconds + CAMERA_PATH_KEYFRAME_EPSILON_SECONDS, current.timeSeconds)
    };
  }
  return keyframes;
}

export function getCameraPathDurationSeconds(cameraPathActor: ActorNode, actors: Record<string, ActorNode>): number {
  const keyframes = getCameraPathKeyframes(cameraPathActor, actors);
  return keyframes[keyframes.length - 1]?.timeSeconds ?? 0;
}

export function getCameraPathKeyframeCount(cameraPathActor: ActorNode, actors: Record<string, ActorNode>): number {
  return getCameraPathKeyframes(cameraPathActor, actors).length;
}

export function getCameraPathValidity(cameraPathActor: ActorNode, actors: Record<string, ActorNode>): {
  ok: boolean;
  message: string | null;
} {
  const refs = resolveCameraPathRefs(cameraPathActor, actors);
  if (!refs.positionCurveActor) {
    return { ok: false, message: "Missing managed position curve." };
  }
  if (refs.targetMode === "actor" && !refs.targetActor) {
    return { ok: false, message: "Target actor is not assigned." };
  }
  if (refs.targetMode === "curve" && !refs.targetCurveActor) {
    return { ok: false, message: "Missing managed target curve." };
  }
  return { ok: true, message: null };
}

export function buildSinglePointCurveData(position: [number, number, number]) {
  return {
    kind: "spline" as const,
    closed: false,
    points: [
      {
        position: [...position] as [number, number, number],
        handleIn: [-0.3, 0, 0] as [number, number, number],
        handleOut: [0.3, 0, 0] as [number, number, number],
        mode: "auto" as const,
        handleInMode: "normal" as const,
        handleOutMode: "normal" as const,
        enabled: true
      }
    ]
  };
}

export function appendCameraPathCurvePoint(
  actor: ActorNode,
  position: [number, number, number]
): ReturnType<typeof curveDataWithOverrides> {
  const current = curveDataWithOverrides(actor);
  return {
    ...current,
    points: [
      ...current.points,
      {
        position: [...position] as [number, number, number],
        handleIn: [-0.3, 0, 0] as [number, number, number],
        handleOut: [0.3, 0, 0] as [number, number, number],
        mode: "auto" as const,
        handleInMode: "normal" as const,
        handleOutMode: "normal" as const,
        enabled: true
      }
    ]
  };
}

export function clampCameraPathKeyframeTime(
  keyframes: CameraPathKeyframe[],
  keyframeIndex: number,
  timeSeconds: number
): number {
  if (keyframeIndex <= 0) {
    return 0;
  }
  const previous = keyframes[keyframeIndex - 1];
  const next = keyframes[keyframeIndex + 1];
  const min = (previous?.timeSeconds ?? 0) + CAMERA_PATH_KEYFRAME_EPSILON_SECONDS;
  const max = next ? next.timeSeconds - CAMERA_PATH_KEYFRAME_EPSILON_SECONDS : Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, Math.max(0, timeSeconds)));
}

export function getCameraPathKeyframeIndexAtTime(
  cameraPathActor: ActorNode,
  actors: Record<string, ActorNode>,
  timeSeconds: number
): number {
  const keyframes = getCameraPathKeyframes(cameraPathActor, actors);
  if (keyframes.length <= 1) {
    return 0;
  }
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < keyframes.length; index += 1) {
    const distance = Math.abs((keyframes[index]?.timeSeconds ?? 0) - timeSeconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function getCameraPathTimeAtKeyframeIndex(
  cameraPathActor: ActorNode,
  actors: Record<string, ActorNode>,
  keyframeIndex: number
): number {
  const keyframes = getCameraPathKeyframes(cameraPathActor, actors);
  if (keyframes.length <= 0) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(keyframes.length - 1, keyframeIndex));
  return keyframes[clamped]?.timeSeconds ?? 0;
}

export function resolveActorWorldMatrix(actorId: string, actors: Record<string, ActorNode>): THREE.Matrix4 {
  const chain: ActorNode[] = [];
  const visited = new Set<string>();
  let cursor: string | null = actorId;
  while (cursor) {
    if (visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    const nextActor: ActorNode | undefined = actors[cursor];
    if (!nextActor) {
      break;
    }
    chain.unshift(nextActor);
    cursor = nextActor.parentActorId;
  }

  const world = new THREE.Matrix4().identity();
  for (const actor of chain) {
    const local = new THREE.Matrix4();
    const position = new THREE.Vector3(...actor.transform.position);
    const rotation = new THREE.Euler(...actor.transform.rotation, "XYZ");
    const quaternion = new THREE.Quaternion().setFromEuler(rotation);
    const scale = new THREE.Vector3(...actor.transform.scale);
    local.compose(position, quaternion, scale);
    world.multiply(local);
  }
  return world;
}

export function sampleCurveWorldPoint(
  actor: ActorNode,
  actors: Record<string, ActorNode>,
  t: number
): { position: [number, number, number]; tangent: [number, number, number] } {
  const sampled = sampleCurvePositionAndTangent(curveDataWithOverrides(actor), t);
  const worldMatrix = resolveActorWorldMatrix(actor.id, actors);
  const worldPosition = new THREE.Vector3(...sampled.position).applyMatrix4(worldMatrix);
  const normalMatrix = new THREE.Matrix3().setFromMatrix4(worldMatrix);
  const worldTangent = new THREE.Vector3(...sampled.tangent).applyMatrix3(normalMatrix).normalize();
  return {
    position: [worldPosition.x, worldPosition.y, worldPosition.z],
    tangent: [worldTangent.x, worldTangent.y, worldTangent.z]
  };
}

export function actorWorldOrigin(actor: ActorNode, actors: Record<string, ActorNode>): [number, number, number] {
  const worldMatrix = resolveActorWorldMatrix(actor.id, actors);
  const worldPosition = new THREE.Vector3(0, 0, 0).applyMatrix4(worldMatrix);
  return [worldPosition.x, worldPosition.y, worldPosition.z];
}

function resolveCurveTForTime(keyframes: CameraPathKeyframe[], timeSeconds: number): number {
  if (keyframes.length <= 1) {
    return 0;
  }
  const duration = keyframes[keyframes.length - 1]?.timeSeconds ?? 0;
  const clampedTime = Math.max(0, Math.min(duration, timeSeconds));
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const start = keyframes[index];
    const end = keyframes[index + 1];
    if (!start || !end) {
      continue;
    }
    if (clampedTime > end.timeSeconds && index < keyframes.length - 2) {
      continue;
    }
    const span = Math.max(CAMERA_PATH_KEYFRAME_EPSILON_SECONDS, end.timeSeconds - start.timeSeconds);
    const alpha = Math.max(0, Math.min(1, (clampedTime - start.timeSeconds) / span));
    return (index + alpha) / (keyframes.length - 1);
  }
  return 1;
}

export function sampleCameraPathPoseAtTime(
  cameraPathActor: ActorNode,
  actors: Record<string, ActorNode>,
  timeSeconds: number
): CameraPathPose | null {
  const refs = resolveCameraPathRefs(cameraPathActor, actors);
  if (!refs.positionCurveActor) {
    return null;
  }
  const keyframes = getCameraPathKeyframes(cameraPathActor, actors);
  if (keyframes.length <= 0) {
    return null;
  }
  const curveT = resolveCurveTForTime(keyframes, timeSeconds);
  const position = sampleCurveWorldPoint(refs.positionCurveActor, actors, curveT).position;

  if (refs.targetMode === "actor") {
    if (!refs.targetActor) {
      return null;
    }
    return {
      position,
      target: actorWorldOrigin(refs.targetActor, actors)
    };
  }

  if (!refs.targetCurveActor) {
    return null;
  }
  return {
    position,
    target: sampleCurveWorldPoint(refs.targetCurveActor, actors, curveT).position
  };
}

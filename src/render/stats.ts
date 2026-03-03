import type { ActorNode, SceneStats } from "@/core/types";

export interface RenderStatsSample {
  drawCalls: number;
  triangles: number;
}

export interface MemorySummary {
  memoryMb: number;
  heapMb: number;
  resourceMb: number;
}

export function bytesToMb(value: number): number {
  return value / (1024 * 1024);
}

export function summarizeMemory(heapBytes: number | null, resourceBytes: number): MemorySummary {
  const resourceMb = bytesToMb(Math.max(0, resourceBytes));
  const heapMb = heapBytes !== null ? bytesToMb(Math.max(0, heapBytes)) : 0;
  const memoryMb = heapBytes !== null ? heapMb + resourceMb : resourceMb;
  return {
    memoryMb,
    heapMb,
    resourceMb
  };
}

export function countActorStats(actors: Record<string, ActorNode>): Pick<SceneStats, "actorCount" | "actorCountEnabled"> {
  const values = Object.values(actors);
  return {
    actorCount: values.length,
    actorCountEnabled: values.filter((actor) => actor.enabled).length
  };
}

import type { ActorNode, SceneStats } from "@/core/types";

export interface RenderStatsSample {
  drawCalls: number;
  triangles: number;
  points: number;
}

export interface CombinedRenderStats {
  drawCalls: number;
  drawCallsMain: number;
  drawCallsOverlay: number;
  triangles: number;
  trianglesMain: number;
  trianglesOverlay: number;
  overlayPoints: number;
}

export interface MemorySummary {
  memoryMb: number;
  heapMb: number;
  resourceMb: number;
}

export function bytesToMb(value: number): number {
  return value / (1024 * 1024);
}

export function combineRenderStats(main: RenderStatsSample, overlay: RenderStatsSample): CombinedRenderStats {
  const drawCallsMain = Math.max(0, Math.floor(main.drawCalls));
  const drawCallsOverlay = Math.max(0, Math.floor(overlay.drawCalls));
  const trianglesMain = Math.max(0, Math.floor(main.triangles));
  const trianglesOverlay = Math.max(0, Math.floor(overlay.triangles));
  const overlayPoints = Math.max(0, Math.floor(overlay.points));

  return {
    drawCalls: drawCallsMain + drawCallsOverlay,
    drawCallsMain,
    drawCallsOverlay,
    triangles: trianglesMain + trianglesOverlay,
    trianglesMain,
    trianglesOverlay,
    overlayPoints
  };
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

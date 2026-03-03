import type { ActorNode } from "@/core/types";

export type GaussianFilterMode = "off" | "inside" | "outside";

export function getGaussianFilterMode(actor: ActorNode): GaussianFilterMode {
  const value = actor.params.filterMode;
  if (value === "inside" || value === "outside") {
    return value;
  }
  return "off";
}

export function getGaussianFilterRegionActorIds(actor: ActorNode): string[] {
  const value = actor.params.filterRegionActorIds;
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      continue;
    }
    unique.add(entry);
  }
  return [...unique];
}

function isSupportedPrimitiveShape(shape: unknown): shape is "sphere" | "cube" | "cylinder" {
  return shape === "sphere" || shape === "cube" || shape === "cylinder";
}

function isPrimitiveActorUsable(actor: ActorNode | undefined): boolean {
  if (!actor || !actor.enabled || actor.actorType !== "primitive") {
    return false;
  }
  const shape = typeof actor.params.shape === "string" ? actor.params.shape : "cube";
  return isSupportedPrimitiveShape(shape);
}

export function hasActiveGaussianFilter(actor: ActorNode, actors: Record<string, ActorNode>): boolean {
  const mode = getGaussianFilterMode(actor);
  if (mode === "off") {
    return false;
  }
  const regionIds = getGaussianFilterRegionActorIds(actor);
  return regionIds.some((regionId) => isPrimitiveActorUsable(actors[regionId]));
}

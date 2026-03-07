import type { ActorNode } from "@/core/types";

export function collectActorRenderOrder(
  rootActorIds: string[],
  actors: Record<string, Pick<ActorNode, "id" | "childActorIds"> | undefined>
): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();

  const visit = (actorId: string): void => {
    if (visited.has(actorId)) {
      return;
    }
    const actor = actors[actorId];
    if (!actor) {
      return;
    }
    visited.add(actorId);
    ordered.push(actorId);
    for (const childId of actor.childActorIds) {
      visit(childId);
    }
  };

  for (const actorId of rootActorIds) {
    visit(actorId);
  }

  return ordered;
}

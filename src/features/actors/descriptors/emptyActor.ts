import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { EMPTY_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface EmptyRuntime {
  tickCount: number;
}

export const emptyActorDescriptor: ReloadableDescriptor<EmptyRuntime> = {
  id: "actor.empty",
  kind: "actor",
  version: 1,
  schema: EMPTY_ACTOR_SCHEMA,
  spawn: {
    actorType: "empty",
    label: "Empty",
    description: "Neutral transform node for grouping and hierarchy.",
    iconGlyph: "E",
    fileExtensions: []
  },
  createRuntime: () => ({
    tickCount: 0
  }),
  updateRuntime(runtime) {
    runtime.tickCount += 1;
  },
  status: {
    build({ actor }) {
      return [
        { label: "Type", value: "Empty" },
        { label: "Children", value: actor.childActorIds.length },
        { label: "Components", value: actor.componentIds.length }
      ];
    }
  }
};

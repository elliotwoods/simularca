import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import { ARRAY_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import { computeInstanceCount, readArrayParams, MAX_INSTANCES_PER_ARRAY } from "@/features/arrayActor/arrayPattern";

interface ArrayRuntime {
  pattern: string;
}

/**
 * Array actor: repeats its authored child subtree(s) into many arranged
 * instances (linear / grid / circular / along-curve). The instances are real,
 * generated actors materialised by the kernel-owned `ArrayReconciler`
 * (`src/features/arrayActor/arrayReconciler.ts`) — this descriptor only renders
 * the array's own transform node and reports status; it does not reconcile.
 */
export const arrayActorDescriptor: ReloadableDescriptor<ArrayRuntime> = {
  id: "actor.array",
  kind: "actor",
  version: 1,
  schema: ARRAY_ACTOR_SCHEMA,
  spawn: {
    actorType: "array",
    label: "Array",
    description: "Repeats its child actors into a linear, grid, circular, or along-curve pattern.",
    iconGlyph: "AR",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({ pattern: readArrayParams(params).pattern }),
  updateRuntime(runtime, { params }) {
    runtime.pattern = readArrayParams(params).pattern;
  },
  status: {
    build({ actor, state }) {
      const params = readArrayParams(actor.params);
      const templateChildren = actor.childActorIds.filter(
        (id) => state.actors[id] && !state.actors[id]!.generatedByActorId
      ).length;
      const count = computeInstanceCount(params);
      const entries: ActorStatusEntry[] = [
        { label: "Type", value: "Array" },
        { label: "Pattern", value: params.pattern },
        { label: "Instances", value: count },
        { label: "Template Children", value: templateChildren }
      ];
      if (params.pattern === "along-curve") {
        entries.push({
          label: "Curve",
          value: state.actors[params.curveActorId]?.name ?? "unassigned"
        });
      }
      if (templateChildren === 0) {
        entries.push({ label: "Status", value: "No template children", tone: "warning" });
      } else if (count >= MAX_INSTANCES_PER_ARRAY) {
        entries.push({ label: "Status", value: `Capped at ${MAX_INSTANCES_PER_ARRAY}`, tone: "warning" });
      }
      return entries;
    }
  }
};

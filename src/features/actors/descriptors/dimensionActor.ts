import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import { DIMENSION_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import {
  describeLandmark,
  formatDistanceMeters,
  readLandmark,
  resolveDimensionAxis,
  resolveDimensionUnits
} from "@/features/dimensions/model";

interface DimensionRuntime {
  axis: "direct" | "x" | "y" | "z";
  units: string;
  decimals: number;
}

export const dimensionActorDescriptor: ReloadableDescriptor<DimensionRuntime> = {
  id: "actor.dimension",
  kind: "actor",
  version: 1,
  schema: DIMENSION_ACTOR_SCHEMA,
  spawn: {
    actorType: "dimension",
    label: "Dimension",
    description: "Measures the distance between two picked landmark points.",
    iconGlyph: "DIM",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    axis: resolveDimensionAxis(params.axis),
    units: resolveDimensionUnits(params.units),
    decimals: Number.isFinite(Number(params.decimals)) ? Math.max(0, Math.floor(Number(params.decimals))) : 2
  }),
  updateRuntime(runtime, { params }) {
    runtime.axis = resolveDimensionAxis(params.axis);
    runtime.units = resolveDimensionUnits(params.units);
    runtime.decimals = Number.isFinite(Number(params.decimals))
      ? Math.max(0, Math.floor(Number(params.decimals)))
      : runtime.decimals;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const start = readLandmark(actor.params.start);
      const end = readLandmark(actor.params.end);
      const axis = resolveDimensionAxis(actor.params.axis);
      const units = resolveDimensionUnits(actor.params.units);
      const decimals = Number.isFinite(Number(actor.params.decimals)) ? Number(actor.params.decimals) : 2;
      const distanceMeters = runtimeStatus?.values.distanceMeters;

      const rows: ActorStatusEntry[] = [
        { label: "Type", value: "Dimension" },
        { label: "Start", value: describeLandmark(start, state) },
        { label: "End", value: describeLandmark(end, state) },
        { label: "Axis", value: axis },
        {
          label: "Distance",
          value:
            typeof distanceMeters === "number"
              ? formatDistanceMeters(distanceMeters, units, decimals)
              : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
      return rows;
    }
  }
};

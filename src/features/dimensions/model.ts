import type { AppState, DimensionAxis, Landmark } from "@/core/types";

/** Conversion factors from meters to the named display unit. */
const UNIT_FACTORS: Record<string, number> = {
  m: 1,
  cm: 100,
  mm: 1000,
  ft: 3.280839895,
  in: 39.37007874
};

export function resolveDimensionUnits(value: unknown): keyof typeof UNIT_FACTORS {
  return typeof value === "string" && value in UNIT_FACTORS ? (value as keyof typeof UNIT_FACTORS) : "m";
}

export function resolveDimensionAxis(value: unknown): DimensionAxis {
  return value === "x" || value === "y" || value === "z" || value === "direct" ? value : "direct";
}

/** Format a distance given in meters into the requested display units. */
export function formatDistanceMeters(meters: number, units: string, decimals: number): string {
  const factor = UNIT_FACTORS[resolveDimensionUnits(units)] ?? 1;
  const safeDecimals = Number.isFinite(decimals) ? Math.max(0, Math.min(6, Math.floor(decimals))) : 2;
  const scaled = meters * factor;
  return `${scaled.toFixed(safeDecimals)} ${resolveDimensionUnits(units)}`;
}

/** Narrow an opaque params value into a Landmark, or null if malformed. */
export function readLandmark(value: unknown): Landmark | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { kind?: unknown };
  if (candidate.kind === "origin") {
    return { kind: "origin" };
  }
  if (candidate.kind === "world") {
    const point = (value as { point?: unknown }).point;
    if (isVec3(point)) {
      return { kind: "world", point: [point[0], point[1], point[2]] };
    }
    return null;
  }
  if (candidate.kind === "actor") {
    const actorId = (value as { actorId?: unknown }).actorId;
    const localOffset = (value as { localOffset?: unknown }).localOffset;
    if (typeof actorId === "string" && isVec3(localOffset)) {
      const label = (value as { label?: unknown }).label;
      return {
        kind: "actor",
        actorId,
        localOffset: [localOffset[0], localOffset[1], localOffset[2]],
        label: typeof label === "string" ? label : undefined
      };
    }
    return null;
  }
  return null;
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

/** Human-readable description of a landmark for the inspector status panel. */
export function describeLandmark(landmark: Landmark | null, state: AppState): string {
  if (!landmark) {
    return "not set";
  }
  if (landmark.kind === "origin") {
    return "Origin";
  }
  if (landmark.kind === "world") {
    const [x, y, z] = landmark.point;
    return `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
  }
  const actor = state.actors[landmark.actorId];
  const base = actor ? actor.name : "missing actor";
  return landmark.label ? `${base} · ${landmark.label}` : base;
}

import type { CurvePoint } from "@/features/curves/types";

export interface EffectiveCurveHandles {
  handleIn: [number, number, number];
  handleOut: [number, number, number];
}

export function getEffectiveCurveHandles(point: CurvePoint): EffectiveCurveHandles {
  if (point.mode === "hard") {
    return {
      handleIn: [0, 0, 0],
      handleOut: [0, 0, 0]
    };
  }
  return {
    handleIn: [...point.handleIn],
    handleOut: [...point.handleOut]
  };
}

export type CurveKind = "spline" | "circle" | "arc" | "helix" | "mesh-projection";
export type CurveHandleMode = "normal" | "mirrored" | "auto" | "hard";
export type CurveHandleWeightMode = "normal" | "hard";

export interface CurvePoint {
  position: [number, number, number];
  handleIn: [number, number, number];
  handleOut: [number, number, number];
  mode: CurveHandleMode;
  handleInMode?: CurveHandleWeightMode;
  handleOutMode?: CurveHandleWeightMode;
  enabled?: boolean;
}

export interface CurveData {
  kind?: CurveKind;
  closed: boolean;
  points: CurvePoint[];
  radius?: number;
  // Sweep fraction in [0, 1] for "arc" curves (1 = full circle and closed).
  arcFraction?: number;
  // Center the "arc" sweep symmetrically about the +X axis (start at -π·fraction).
  arcCentered?: boolean;
  // Vertical rise per full revolution (m) for "helix" curves.
  helixPitch?: number;
  // Number of revolutions over t ∈ [0, 1] for "helix" curves.
  helixTurns?: number;
  // Runtime-only: populated for mesh-projection curves before sampling.
  // Not persisted (sanitizeCurveData drops it).
  projectedPoints?: ([number, number, number] | null)[];
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function sanitizeVector3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    return [...fallback] as [number, number, number];
  }
  return [
    toFiniteNumber(value[0], fallback[0]),
    toFiniteNumber(value[1], fallback[1]),
    toFiniteNumber(value[2], fallback[2])
  ];
}

function sanitizeHandleMode(value: unknown): CurveHandleMode {
  if (value === "mirrored" || value === "hard" || value === "normal" || value === "auto") {
    return value;
  }
  if (value === "free" || value === "aligned") {
    return "normal";
  }
  return "normal";
}

function sanitizeHandleWeightMode(value: unknown): CurveHandleWeightMode {
  return value === "hard" ? "hard" : "normal";
}

function sanitizeCurveKind(value: unknown): CurveKind {
  if (value === "circle") return "circle";
  if (value === "arc") return "arc";
  if (value === "helix") return "helix";
  if (value === "mesh-projection") return "mesh-projection";
  return "spline";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePoint(value: unknown, fallback: CurvePoint): CurvePoint {
  if (!value || typeof value !== "object") {
    return {
      position: [...fallback.position],
      handleIn: [...fallback.handleIn],
      handleOut: [...fallback.handleOut],
      mode: fallback.mode
    };
  }

  const source = value as {
    position?: unknown;
    handleIn?: unknown;
    handleOut?: unknown;
    mode?: unknown;
    handleInMode?: unknown;
    handleOutMode?: unknown;
    enabled?: unknown;
  };
  const mode = sanitizeHandleMode(source.mode);
  const inferredInMode =
    mode === "hard"
      ? "hard"
      : sanitizeHandleWeightMode(source.handleInMode ?? fallback.handleInMode ?? "normal");
  const inferredOutMode =
    mode === "hard"
      ? "hard"
      : sanitizeHandleWeightMode(source.handleOutMode ?? fallback.handleOutMode ?? "normal");

  return {
    position: sanitizeVector3(source.position, fallback.position),
    handleIn: sanitizeVector3(source.handleIn, fallback.handleIn),
    handleOut: sanitizeVector3(source.handleOut, fallback.handleOut),
    mode: mode === "hard" ? "normal" : mode,
    handleInMode: inferredInMode,
    handleOutMode: inferredOutMode,
    enabled: source.enabled === false ? false : true
  };
}

export function createDefaultCurveData(): CurveData {
  return {
    kind: "spline",
    closed: false,
    points: [
      {
        position: [-0.75, 0, 0],
        handleIn: [-0.35, 0, 0],
        handleOut: [0.35, 0, 0],
        mode: "mirrored",
        handleInMode: "normal",
        handleOutMode: "normal",
        enabled: true
      },
      {
        position: [0.75, 0, 0],
        handleIn: [-0.35, 0, 0],
        handleOut: [0.35, 0, 0],
        mode: "mirrored",
        handleInMode: "normal",
        handleOutMode: "normal",
        enabled: true
      }
    ]
  };
}

export function createCircleCurveData(radius = 1): CurveData {
  return {
    kind: "circle",
    closed: true,
    points: [],
    radius: Math.max(0, toFiniteNumber(radius, 1))
  };
}

export function createArcCurveData(radius = 1, fraction = 1, centered = false): CurveData {
  const safeFraction = clamp(toFiniteNumber(fraction, 1), 0, 1);
  return {
    kind: "arc",
    closed: safeFraction >= 1,
    points: [],
    radius: Math.max(0, toFiniteNumber(radius, 1)),
    arcFraction: safeFraction,
    arcCentered: Boolean(centered)
  };
}

export function createHelixCurveData(radius = 1, pitch = 1, turns = 1): CurveData {
  return {
    kind: "helix",
    closed: false,
    points: [],
    radius: Math.max(0, toFiniteNumber(radius, 1)),
    helixPitch: Math.max(0, toFiniteNumber(pitch, 1)),
    helixTurns: Math.max(0.01, toFiniteNumber(turns, 1))
  };
}

export function sanitizeCurveData(value: unknown, fallback?: CurveData): CurveData {
  const baseline = fallback ?? createDefaultCurveData();
  const baselineKind = sanitizeCurveKind(baseline.kind);
  if (!value || typeof value !== "object") {
    if (baselineKind === "circle") {
      return createCircleCurveData(baseline.radius ?? 1);
    }
    if (baselineKind === "arc") {
      return createArcCurveData(baseline.radius ?? 1, baseline.arcFraction ?? 1, baseline.arcCentered ?? false);
    }
    if (baselineKind === "helix") {
      return createHelixCurveData(
        baseline.radius ?? 1,
        baseline.helixPitch ?? 1,
        baseline.helixTurns ?? 1
      );
    }
    if (baselineKind === "mesh-projection") {
      return { kind: "mesh-projection", closed: true, points: [] };
    }
    return {
      kind: "spline",
      closed: baseline.closed,
      points: baseline.points.map((point) => sanitizePoint(point, point))
    };
  }

  const source = value as {
    kind?: unknown;
    closed?: unknown;
    points?: unknown;
    radius?: unknown;
    arcFraction?: unknown;
    arcCentered?: unknown;
    helixPitch?: unknown;
    helixTurns?: unknown;
  };
  const kind = sanitizeCurveKind(source.kind ?? baseline.kind);
  if (kind === "circle") {
    const fallbackRadius = typeof baseline.radius === "number" ? baseline.radius : 1;
    return createCircleCurveData(toFiniteNumber(source.radius, fallbackRadius));
  }
  if (kind === "arc") {
    const fallbackRadius = typeof baseline.radius === "number" ? baseline.radius : 1;
    const fallbackFraction = typeof baseline.arcFraction === "number" ? baseline.arcFraction : 1;
    const fallbackCentered = typeof baseline.arcCentered === "boolean" ? baseline.arcCentered : false;
    const centered = typeof source.arcCentered === "boolean" ? source.arcCentered : fallbackCentered;
    return createArcCurveData(
      toFiniteNumber(source.radius, fallbackRadius),
      toFiniteNumber(source.arcFraction, fallbackFraction),
      centered
    );
  }
  if (kind === "helix") {
    const fallbackRadius = typeof baseline.radius === "number" ? baseline.radius : 1;
    const fallbackPitch = typeof baseline.helixPitch === "number" ? baseline.helixPitch : 1;
    const fallbackTurns = typeof baseline.helixTurns === "number" ? baseline.helixTurns : 1;
    return createHelixCurveData(
      toFiniteNumber(source.radius, fallbackRadius),
      toFiniteNumber(source.helixPitch, fallbackPitch),
      toFiniteNumber(source.helixTurns, fallbackTurns)
    );
  }
  if (kind === "mesh-projection") {
    return { kind: "mesh-projection", closed: true, points: [] };
  }

  const defaultPoints = createDefaultCurveData().points;
  const firstDefaultPoint = defaultPoints[0] ?? {
    position: [0, 0, 0] as [number, number, number],
    handleIn: [-0.3, 0, 0] as [number, number, number],
    handleOut: [0.3, 0, 0] as [number, number, number],
    mode: "mirrored" as CurveHandleMode
  };
  const sourcePoints = Array.isArray(source.points) ? source.points : [];
  const fallbackPoints = baseline.points.length > 0 ? baseline.points : defaultPoints;
  const points = sourcePoints.map((entry, index) => {
    const fallbackPoint = fallbackPoints[Math.min(index, fallbackPoints.length - 1)] ?? firstDefaultPoint;
    return sanitizePoint(entry, fallbackPoint);
  });

  return {
    kind: "spline",
    closed: Boolean(source.closed),
    points
  };
}

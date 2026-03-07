export type CurveKind = "spline" | "circle";
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
  return value === "circle" ? "circle" : "spline";
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

export function sanitizeCurveData(value: unknown, fallback?: CurveData): CurveData {
  const baseline = fallback ?? createDefaultCurveData();
  const baselineKind = sanitizeCurveKind(baseline.kind);
  if (!value || typeof value !== "object") {
    return baselineKind === "circle"
      ? createCircleCurveData(baseline.radius ?? 1)
      : {
        kind: "spline",
        closed: baseline.closed,
        points: baseline.points.map((point) => sanitizePoint(point, point))
      };
  }

  const source = value as { kind?: unknown; closed?: unknown; points?: unknown; radius?: unknown };
  const kind = sanitizeCurveKind(source.kind ?? baseline.kind);
  if (kind === "circle") {
    const fallbackRadius = typeof baseline.radius === "number" ? baseline.radius : 1;
    return createCircleCurveData(toFiniteNumber(source.radius, fallbackRadius));
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

export type CurveHandleMode = "normal" | "mirrored" | "hard";

export interface CurvePoint {
  position: [number, number, number];
  handleIn: [number, number, number];
  handleOut: [number, number, number];
  mode: CurveHandleMode;
}

export interface CurveData {
  closed: boolean;
  points: CurvePoint[];
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
  if (value === "mirrored" || value === "hard" || value === "normal") {
    return value;
  }
  if (value === "free" || value === "aligned") {
    return "normal";
  }
  return "normal";
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
  };

  return {
    position: sanitizeVector3(source.position, fallback.position),
    handleIn: sanitizeVector3(source.handleIn, fallback.handleIn),
    handleOut: sanitizeVector3(source.handleOut, fallback.handleOut),
    mode: sanitizeHandleMode(source.mode)
  };
}

export function createDefaultCurveData(): CurveData {
  return {
    closed: false,
    points: [
      {
        position: [-0.75, 0, 0],
        handleIn: [-0.35, 0, 0],
        handleOut: [0.35, 0, 0],
        mode: "mirrored"
      },
      {
        position: [0.75, 0, 0],
        handleIn: [-0.35, 0, 0],
        handleOut: [0.35, 0, 0],
        mode: "mirrored"
      }
    ]
  };
}

export function sanitizeCurveData(value: unknown, fallback?: CurveData): CurveData {
  const baseline = fallback ?? createDefaultCurveData();
  const defaultPoints = createDefaultCurveData().points;
  const firstDefaultPoint = defaultPoints[0] ?? {
    position: [0, 0, 0] as [number, number, number],
    handleIn: [-0.3, 0, 0] as [number, number, number],
    handleOut: [0.3, 0, 0] as [number, number, number],
    mode: "mirrored" as CurveHandleMode
  };
  if (!value || typeof value !== "object") {
    return {
      closed: baseline.closed,
      points: baseline.points.map((point) => sanitizePoint(point, point))
    };
  }

  const source = value as { closed?: unknown; points?: unknown };
  const sourcePoints = Array.isArray(source.points) ? source.points : [];
  const fallbackPoints = baseline.points.length > 0 ? baseline.points : defaultPoints;
  const points = sourcePoints.map((entry, index) => {
    const fallbackPoint = fallbackPoints[Math.min(index, fallbackPoints.length - 1)] ?? firstDefaultPoint;
    return sanitizePoint(entry, fallbackPoint);
  });

  if (points.length < 2) {
    const seed = fallbackPoints.slice(0, 2).map((point) => sanitizePoint(point, point));
    while (points.length < 2) {
      const next = seed[points.length] ?? seed[seed.length - 1] ?? firstDefaultPoint;
      points.push(sanitizePoint(next, next));
    }
  }

  return {
    closed: Boolean(source.closed),
    points
  };
}

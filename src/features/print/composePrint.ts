import type { OrthoEdgeMapping } from "@/features/camera/viewUtils";
import type { PrintSettings } from "@/features/print/types";

const AXIS_LETTERS = ["X", "Y", "Z"] as const;

const RULER_TICK_STEPS_M = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MIN_MAJOR_TICK_SPACING_PX = 64;
// Mirror the scene grid's LOD (sceneGridController.ts): below this on-screen
// spacing the minor ticks are dropped and only majors are drawn.
const MIN_MINOR_PIXEL_SPACING = 6;
// Keep major-tick labels at least this far apart so they stay legible.
const MIN_MAJOR_LABEL_SPACING_PX = 48;

/**
 * Choose a "nice" ruler step (in metres) so major ticks are at least
 * `MIN_MAJOR_TICK_SPACING_PX` apart at the given resolution. Used only as a
 * fallback when the scene grid pitch is unavailable.
 */
function chooseRulerStepMeters(pixelsPerMeter: number): number {
  for (const step of RULER_TICK_STEPS_M) {
    if (step * pixelsPerMeter >= MIN_MAJOR_TICK_SPACING_PX) {
      return step;
    }
  }
  return RULER_TICK_STEPS_M[RULER_TICK_STEPS_M.length - 1] ?? 1;
}

/** Whether `value` metres lands on a major-pitch multiple. Mirrors the grid. */
function isMajorTick(value: number, majorPitch: number): boolean {
  const ratio = value / majorPitch;
  return Math.abs(ratio - Math.round(ratio)) < 1e-4;
}

/** Format a world-coordinate value (metres) for a ruler label. */
function formatWorldLabel(value: number): string {
  const snapped = Math.abs(value) < 1e-6 ? 0 : value;
  if (Number.isInteger(snapped)) {
    return String(snapped);
  }
  return Number(snapped.toFixed(2)).toString();
}

function formatRulerLabel(meters: number): string {
  if (meters < 1) {
    return `${Math.round(meters * 100)}cm`;
  }
  return Number.isInteger(meters) ? `${meters}m` : `${meters.toFixed(1)}m`;
}

function invertInPlace(context: CanvasRenderingContext2D, width: number, height: number): void {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - (data[i] ?? 0);
    data[i + 1] = 255 - (data[i + 1] ?? 0);
    data[i + 2] = 255 - (data[i + 2] ?? 0);
    // leave alpha (i + 3) untouched
  }
  context.putImageData(image, 0, 0);
}

/**
 * Resolve the minor/major tick pitch (in metres) for the edge ruler. Prefers the
 * scene grid pitch so the ruler matches the on-screen grid; falls back to a
 * resolution-based "nice step" when the grid pitch is unknown.
 */
function resolveRulerPitch(
  pixelsPerMeter: number,
  majorPitch: number | undefined,
  minorPitch: number | undefined
): { minor: number; major: number } {
  const validMinor = typeof minorPitch === "number" && Number.isFinite(minorPitch) && minorPitch > 0;
  const validMajor = typeof majorPitch === "number" && Number.isFinite(majorPitch) && majorPitch > 0;
  if (validMinor && validMajor) {
    return { minor: minorPitch, major: Math.max(minorPitch, majorPitch) };
  }
  const step = chooseRulerStepMeters(pixelsPerMeter);
  return { minor: step, major: step * 5 };
}

function drawEdgeRuler(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  pixelsPerMeter: number,
  invert: boolean,
  majorPitch: number | undefined,
  minorPitch: number | undefined
): void {
  if (!(pixelsPerMeter > 0) || !Number.isFinite(pixelsPerMeter)) {
    return;
  }
  const { minor, major } = resolveRulerPitch(pixelsPerMeter, majorPitch, minorPitch);
  const minorPx = minor * pixelsPerMeter;
  const majorPx = major * pixelsPerMeter;
  const drawMinor = minorPx >= MIN_MINOR_PIXEL_SPACING;
  // The tick stepping iterates in minor units; if minors are dropped, step by majors.
  const stepMeters = drawMinor ? minor : major;
  const labelEveryK = majorPx > 0 ? Math.max(1, Math.ceil(MIN_MAJOR_LABEL_SPACING_PX / majorPx)) : 1;

  const scale = Math.min(width, height);
  const band = Math.max(18, Math.round(scale * 0.022));
  const majorTick = band * 0.6;
  const minorTick = band * 0.32;
  const fontSize = Math.max(10, Math.round(band * 0.45));

  // On invert the page is white, so draw dark; otherwise draw light on dark.
  const ink = invert ? "#101010" : "#f2f2f2";
  const bandFill = invert ? "rgba(255,255,255,0.82)" : "rgba(10,14,22,0.82)";

  context.save();
  context.fillStyle = bandFill;
  context.fillRect(0, 0, width, band);
  context.fillRect(0, 0, band, height);

  context.strokeStyle = ink;
  context.fillStyle = ink;
  context.lineWidth = Math.max(1, Math.round(scale * 0.0009));
  context.font = `${fontSize}px sans-serif`;
  context.textBaseline = "top";

  const drawTicks = (horizontal: boolean): void => {
    const limit = horizontal ? width : height;
    context.textAlign = "left";
    for (let i = 0; ; i += 1) {
      const coord = i * stepMeters;
      const pos = band + coord * pixelsPerMeter;
      if (pos > limit) {
        break;
      }
      const isMajor = isMajorTick(coord, major);
      const tick = isMajor ? majorTick : minorTick;
      context.beginPath();
      if (horizontal) {
        context.moveTo(pos, band);
        context.lineTo(pos, band - tick);
      } else {
        context.moveTo(band, pos);
        context.lineTo(band - tick, pos);
      }
      context.stroke();
      if (isMajor && coord > 0) {
        const majorIndex = Math.round(coord / major);
        if (majorIndex % labelEveryK === 0) {
          if (horizontal) {
            context.fillText(formatRulerLabel(coord), pos + 3, 2);
          } else {
            context.save();
            context.translate(2, pos + 3);
            context.rotate(Math.PI / 2);
            context.fillText(formatRulerLabel(coord), 0, 0);
            context.restore();
          }
        }
      }
    }
  };

  drawTicks(true);
  drawTicks(false);
  context.restore();
}

/**
 * Draw a world-coordinate ruler on all four edges, aligned to the scene grid.
 * Tick positions are world multiples of the grid pitch mapped to pixels via the
 * orthographic edge mapping, and labels show the actual world coordinate on the
 * appropriate axis (horizontal = `ruler.axisU`, vertical = `ruler.axisV`).
 */
function drawWorldRuler(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  invert: boolean,
  majorPitch: number,
  minorPitch: number,
  ruler: OrthoEdgeMapping
): void {
  const minor = Number.isFinite(minorPitch) && minorPitch > 0 ? minorPitch : 1;
  const major = Number.isFinite(majorPitch) && majorPitch > 0 ? Math.max(minor, majorPitch) : minor;

  const scale = Math.min(width, height);
  const band = Math.max(18, Math.round(scale * 0.022));
  const majorTick = band * 0.6;
  const minorTick = band * 0.32;
  const fontSize = Math.max(10, Math.round(band * 0.45));
  const ink = invert ? "#101010" : "#f2f2f2";
  const bandFill = invert ? "rgba(255,255,255,0.82)" : "rgba(10,14,22,0.82)";

  context.save();
  context.fillStyle = bandFill;
  context.fillRect(0, 0, width, band); // top
  context.fillRect(0, height - band, width, band); // bottom
  context.fillRect(0, 0, band, height); // left
  context.fillRect(width - band, 0, band, height); // right

  context.strokeStyle = ink;
  context.fillStyle = ink;
  context.lineWidth = Math.max(1, Math.round(scale * 0.0009));
  context.font = `${fontSize}px sans-serif`;

  // Walk world coords from low→high; map to pixels via the linear edge mapping.
  const drawAxis = (
    worldLow: number,
    worldHigh: number,
    toPixel: (coord: number) => number,
    pixelExtent: number,
    horizontal: boolean
  ): void => {
    const span = worldHigh - worldLow;
    if (!(Math.abs(span) > 1e-9)) {
      return;
    }
    const pxPerMeter = Math.abs(pixelExtent / span);
    const drawMinor = minor * pxPerMeter >= MIN_MINOR_PIXEL_SPACING;
    const stepMeters = drawMinor ? minor : major;
    const labelEveryK = major * pxPerMeter > 0 ? Math.max(1, Math.ceil(MIN_MAJOR_LABEL_SPACING_PX / (major * pxPerMeter))) : 1;
    const start = Math.ceil(worldLow / stepMeters - 1e-6);
    const end = Math.floor(worldHigh / stepMeters + 1e-6);
    for (let i = start; i <= end; i += 1) {
      const coord = i * stepMeters;
      const pos = toPixel(coord);
      const isMajor = isMajorTick(coord, major);
      const tick = isMajor ? majorTick : minorTick;
      context.beginPath();
      if (horizontal) {
        // Top edge
        context.moveTo(pos, band);
        context.lineTo(pos, band - tick);
        // Bottom edge
        context.moveTo(pos, height - band);
        context.lineTo(pos, height - band + tick);
      } else {
        // Left edge
        context.moveTo(band, pos);
        context.lineTo(band - tick, pos);
        // Right edge
        context.moveTo(width - band, pos);
        context.lineTo(width - band + tick, pos);
      }
      context.stroke();
      if (isMajor) {
        const majorIndex = Math.round(coord / major);
        // Keep labels off the perpendicular corner bands.
        const clear = horizontal ? pos > band + 2 && pos < width - band - 2 : pos > band + 2 && pos < height - band - 2;
        if (majorIndex % labelEveryK === 0 && clear) {
          context.save();
          if (horizontal) {
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillText(formatWorldLabel(coord), pos, 2); // top band
            context.textBaseline = "bottom";
            context.fillText(formatWorldLabel(coord), pos, height - 2); // bottom band
          } else {
            context.textAlign = "left";
            context.textBaseline = "middle";
            context.translate(2, pos);
            context.rotate(Math.PI / 2);
            context.fillText(formatWorldLabel(coord), 0, 0);
            context.restore();
            context.save();
            context.textAlign = "right";
            context.textBaseline = "middle";
            context.translate(width - 2, pos);
            context.rotate(Math.PI / 2);
            context.fillText(formatWorldLabel(coord), 0, 0);
          }
          context.restore();
        }
      }
    }
  };

  // Horizontal axis (top + bottom): worldAtLeft at x=0, worldAtRight at x=width.
  const hLow = Math.min(ruler.worldAtLeft, ruler.worldAtRight);
  const hHigh = Math.max(ruler.worldAtLeft, ruler.worldAtRight);
  drawAxis(
    hLow,
    hHigh,
    (coord) => ((coord - ruler.worldAtLeft) / (ruler.worldAtRight - ruler.worldAtLeft)) * width,
    width,
    true
  );
  // Vertical axis (left + right): worldAtTop at y=0, worldAtBottom at y=height.
  const vLow = Math.min(ruler.worldAtTop, ruler.worldAtBottom);
  const vHigh = Math.max(ruler.worldAtTop, ruler.worldAtBottom);
  drawAxis(
    vLow,
    vHigh,
    (coord) => ((coord - ruler.worldAtTop) / (ruler.worldAtBottom - ruler.worldAtTop)) * height,
    height,
    false
  );

  // Axis letters in the top-left corner (horizontal axisU, vertical axisV).
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `bold ${fontSize}px sans-serif`;
  context.fillText(`${AXIS_LETTERS[ruler.axisU]}→`, band + fontSize, Math.round(band / 2));
  context.save();
  context.translate(Math.round(band / 2), band + fontSize);
  context.rotate(Math.PI / 2);
  context.fillText(`${AXIS_LETTERS[ruler.axisV]}→`, 0, 0);
  context.restore();

  context.restore();
}

/**
 * Composite a rendered frame into a print-ready canvas: optional full-image
 * colour invert (dark editor background → white paper) and an optional edge
 * ruler labelled in metres (drawn only when `pixelsPerMeter` is known). The
 * ruler tick pitch follows the scene grid when `gridMajorPitch`/`gridMinorPitch`
 * are supplied.
 */
export function composePrintCanvas(args: {
  source: HTMLCanvasElement;
  settings: PrintSettings;
  pixelsPerMeter: number | null;
  gridMajorPitch?: number;
  gridMinorPitch?: number;
  ruler?: OrthoEdgeMapping | null;
}): HTMLCanvasElement {
  const { source, settings } = args;
  const width = Math.max(1, source.width);
  const height = Math.max(1, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create print compositing canvas.");
  }

  context.drawImage(source, 0, 0, width, height);

  if (settings.invert) {
    invertInPlace(context, width, height);
  }

  if (settings.showRuler && args.ruler) {
    // World-coordinate ruler aligned to the grid (axis-aligned ortho views).
    drawWorldRuler(
      context,
      width,
      height,
      settings.invert,
      args.gridMajorPitch ?? 1,
      args.gridMinorPitch ?? 0.1,
      args.ruler
    );
  } else if (settings.showRuler && args.pixelsPerMeter) {
    // Fallback relative ruler (non-axis-aligned ortho).
    drawEdgeRuler(context, width, height, args.pixelsPerMeter, settings.invert, args.gridMajorPitch, args.gridMinorPitch);
  }

  return canvas;
}

/**
 * Sample a canvas at reduced resolution and report whether its opaque pixels are
 * mostly dark (mean Rec.709 luminance below `threshold`, 0..1). Used to default
 * the print "invert" toggle on for dark editor scenes.
 */
export function isCanvasMostlyDark(canvas: HTMLCanvasElement, threshold = 0.22): boolean {
  const probe = document.createElement("canvas");
  probe.width = Math.max(1, Math.min(canvas.width, 80));
  probe.height = Math.max(1, Math.min(canvas.height, 80));
  const ctx = probe.getContext("2d");
  if (!ctx) {
    return false;
  }
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0) {
      continue;
    }
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    count += 1;
  }
  if (count === 0) {
    return false;
  }
  return sum / count < threshold;
}

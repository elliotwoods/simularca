import type { PrintSettings } from "@/features/print/types";

const RULER_TICK_STEPS_M = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MIN_MAJOR_TICK_SPACING_PX = 64;

/**
 * Choose a "nice" ruler step (in metres) so major ticks are at least
 * `MIN_MAJOR_TICK_SPACING_PX` apart at the given resolution.
 */
function chooseRulerStepMeters(pixelsPerMeter: number): number {
  for (const step of RULER_TICK_STEPS_M) {
    if (step * pixelsPerMeter >= MIN_MAJOR_TICK_SPACING_PX) {
      return step;
    }
  }
  return RULER_TICK_STEPS_M[RULER_TICK_STEPS_M.length - 1] ?? 1;
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

function drawEdgeRuler(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  pixelsPerMeter: number,
  invert: boolean
): void {
  if (!(pixelsPerMeter > 0) || !Number.isFinite(pixelsPerMeter)) {
    return;
  }
  const step = chooseRulerStepMeters(pixelsPerMeter);
  const stepPx = step * pixelsPerMeter;
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

  // Top ruler — measured from the left edge.
  context.textAlign = "left";
  let index = 0;
  for (let x = band; x <= width; x += stepPx) {
    const isMajor = index % 5 === 0;
    const tick = isMajor ? majorTick : minorTick;
    context.beginPath();
    context.moveTo(x, band);
    context.lineTo(x, band - tick);
    context.stroke();
    if (isMajor && index > 0) {
      context.fillText(formatRulerLabel(index * step), x + 3, 2);
    }
    index += 1;
  }

  // Left ruler — measured from the top edge.
  index = 0;
  for (let y = band; y <= height; y += stepPx) {
    const isMajor = index % 5 === 0;
    const tick = isMajor ? majorTick : minorTick;
    context.beginPath();
    context.moveTo(band, y);
    context.lineTo(band - tick, y);
    context.stroke();
    if (isMajor && index > 0) {
      context.save();
      context.translate(2, y + 3);
      context.rotate(Math.PI / 2);
      context.fillText(formatRulerLabel(index * step), 0, 0);
      context.restore();
    }
    index += 1;
  }
  context.restore();
}

/**
 * Composite a rendered frame into a print-ready canvas: optional full-image
 * colour invert (dark editor background → white paper) and an optional edge
 * ruler labelled in metres (drawn only when `pixelsPerMeter` is known).
 */
export function composePrintCanvas(args: {
  source: HTMLCanvasElement;
  settings: PrintSettings;
  pixelsPerMeter: number | null;
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

  if (settings.showRuler && args.pixelsPerMeter) {
    drawEdgeRuler(context, width, height, args.pixelsPerMeter, settings.invert);
  }

  return canvas;
}

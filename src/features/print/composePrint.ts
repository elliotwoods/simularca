import type { OrthoEdgeMapping } from "@/features/camera/viewUtils";
import type { PrintOverlayCurve, PrintOverlayDimension, PrintVectorOverlay } from "@/features/print/printVectorOverlay";
import type { PrintSettings } from "@/features/print/types";

const AXIS_LETTERS = ["X", "Y", "Z"] as const;

const RULER_TICK_STEPS_M = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MIN_MAJOR_TICK_SPACING_PX = 64;
// Mirror the scene grid's LOD (sceneGridController.ts): below this on-screen
// spacing the minor ticks are dropped and only majors are drawn.
const MIN_MINOR_PIXEL_SPACING = 6;
// Keep major-tick labels at least this far apart so they stay legible.
const MIN_MAJOR_LABEL_SPACING_PX = 48;
// Minor grid lines render at this fraction of the major-line opacity so they
// read as a fainter sub-division of the majors.
const MINOR_GRID_ALPHA_FACTOR = 0.4;

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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Snap a coordinate to a half-pixel so 1px strokes render crisply. */
function snapHalf(value: number): number {
  return Math.round(value) + 0.5;
}

/** Invert a `#rrggbb` hex colour (for grid lines under full-image invert). */
export function invertHex(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const hexPart = match?.[1];
  if (!hexPart) {
    return hex;
  }
  const n = parseInt(hexPart, 16);
  const r = 255 - ((n >> 16) & 0xff);
  const g = 255 - ((n >> 8) & 0xff);
  const b = 255 - (n & 0xff);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
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
      // Keep ticks (and labels) out of the perpendicular corner bands so the
      // opposite axis's ticks never intrude on this axis's corner — e.g. an
      // X tick bleeding into the Z corner (which can read as "−X").
      const clear = horizontal ? pos > band && pos < width - band : pos > band && pos < height - band;
      if (!clear) {
        continue;
      }
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
        if (majorIndex % labelEveryK === 0) {
          context.save();
          if (horizontal) {
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillText(formatWorldLabel(coord), pos, 2); // top band
            context.textBaseline = "bottom";
            context.fillText(formatWorldLabel(coord), pos, height - 2); // bottom band
          } else {
            // Left + right bands: read along the band, centred within the band
            // (so glyphs can't spill past the page edge — the old anchor at the
            // extreme edge clipped half the digit height off the print region)
            // and centred on the tick line.
            const label = formatWorldLabel(coord);
            const half = Math.round(band / 2);
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.translate(half, pos); // left edge
            context.rotate(-Math.PI / 2);
            context.fillText(label, 0, 0);
            context.restore();
            context.save();
            context.translate(width - half, pos); // right edge
            context.rotate(-Math.PI / 2);
            context.fillText(label, 0, 0);
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
 * Draw the scene grid as crisp 1px vector hairlines, aligned to the same world↔
 * pixel mapping as the ruler so grid lines and ruler ticks coincide exactly.
 * Used in place of the rasterised 3D grid for axis-aligned ortho prints, where
 * the GL grid would be sub-pixel/faint at print DPI.
 */
function drawVectorGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  ruler: OrthoEdgeMapping,
  majorPitch: number,
  minorPitch: number,
  majorColor: string,
  minorColor: string,
  opacity: number,
  invert: boolean
): void {
  const minor = Number.isFinite(minorPitch) && minorPitch > 0 ? minorPitch : 1;
  const major = Number.isFinite(majorPitch) && majorPitch > 0 ? Math.max(minor, majorPitch) : minor;
  const majorInk = invert ? invertHex(majorColor) : majorColor;
  const minorInk = invert ? invertHex(minorColor) : minorColor;

  context.save();
  context.lineWidth = 1; // hairline

  const drawSet = (worldLow: number, worldHigh: number, toPixel: (coord: number) => number, pixelExtent: number, vertical: boolean): void => {
    const span = Math.abs(worldHigh - worldLow);
    if (!(span > 1e-9)) {
      return;
    }
    const pxPerMeter = pixelExtent / span;
    const drawMinor = minor * pxPerMeter >= MIN_MINOR_PIXEL_SPACING;
    const stepMeters = drawMinor ? minor : major;
    const start = Math.ceil(worldLow / stepMeters - 1e-6);
    const end = Math.floor(worldHigh / stepMeters + 1e-6);
    for (let i = start; i <= end; i += 1) {
      const coord = i * stepMeters;
      const isMajor = isMajorTick(coord, major);
      context.globalAlpha = clamp01(isMajor ? opacity : opacity * MINOR_GRID_ALPHA_FACTOR);
      context.strokeStyle = isMajor ? majorInk : minorInk;
      const p = snapHalf(toPixel(coord));
      context.beginPath();
      if (vertical) {
        context.moveTo(p, 0);
        context.lineTo(p, height);
      } else {
        context.moveTo(0, p);
        context.lineTo(width, p);
      }
      context.stroke();
    }
  };

  // Horizontal axis → vertical grid lines (constant x); vertical axis → horizontal lines.
  const hLow = Math.min(ruler.worldAtLeft, ruler.worldAtRight);
  const hHigh = Math.max(ruler.worldAtLeft, ruler.worldAtRight);
  drawSet(hLow, hHigh, (c) => ((c - ruler.worldAtLeft) / (ruler.worldAtRight - ruler.worldAtLeft)) * width, width, true);
  const vLow = Math.min(ruler.worldAtTop, ruler.worldAtBottom);
  const vHigh = Math.max(ruler.worldAtTop, ruler.worldAtBottom);
  drawSet(vLow, vHigh, (c) => ((c - ruler.worldAtTop) / (ruler.worldAtBottom - ruler.worldAtTop)) * height, height, false);

  context.restore();
}

/** Draw the title block (Simularca · version · project · snapshot) bottom-right. */
function drawInfoBlock(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  invert: boolean,
  info: { version: string; project: string; snapshot: string },
  bottomInset: number
): void {
  const parts = [`Simularca v${info.version}`];
  if (info.project.trim()) {
    parts.push(info.project.trim());
  }
  if (info.snapshot.trim()) {
    parts.push(info.snapshot.trim());
  }
  const text = parts.join("  ·  ");
  const scale = Math.min(width, height);
  const fontSize = Math.max(11, Math.round(scale * 0.013));
  const pad = Math.max(4, Math.round(fontSize * 0.5));
  const margin = Math.max(6, Math.round(scale * 0.01));

  context.save();
  context.font = `${fontSize}px sans-serif`;
  context.textAlign = "right";
  context.textBaseline = "bottom";
  const x = width - bottomInset - margin;
  const y = height - bottomInset - margin;
  const textW = context.measureText(text).width;
  context.fillStyle = invert ? "rgba(255,255,255,0.78)" : "rgba(10,14,22,0.78)";
  context.fillRect(x - textW - pad, y - fontSize - pad, textW + pad * 2, fontSize + pad * 2);
  context.fillStyle = invert ? "#101010" : "#f2f2f2";
  context.fillText(text, x - pad, y - pad);
  context.restore();
}

/** Resolve an overlay ink colour, inverting it (like the grid) when the page is inverted. */
function overlayInk(color: string, invert: boolean): string {
  return invert ? invertHex(color) : color;
}

/**
 * Contrast halo drawn under overlay lines so they stay legible — and read as
 * unambiguously on top — over bright HDR primitives and busy geometry. Dark on a
 * normal print, light on an inverted (white) page.
 */
function overlayHalo(invert: boolean): string {
  return invert ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.6)";
}

/**
 * Stroke the current path twice: first a wider contrast halo, then the ink on
 * top. The path persists between `stroke()` calls (until the next `beginPath`),
 * so the caller builds it once before invoking this.
 */
function strokeWithHalo(
  context: CanvasRenderingContext2D,
  ink: string,
  lineWidth: number,
  invert: boolean
): void {
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = overlayHalo(invert);
  context.lineWidth = lineWidth + Math.max(2, Math.round(lineWidth * 1.2));
  context.stroke();
  context.strokeStyle = ink;
  context.lineWidth = lineWidth;
  context.stroke();
}

/** Stroke projected curve polylines as crisp vector lines with a contrast halo. */
function drawVectorCurves(
  context: CanvasRenderingContext2D,
  curves: PrintOverlayCurve[],
  width: number,
  height: number,
  invert: boolean
): void {
  const scale = Math.min(width, height);
  const lineWidth = Math.max(1, Math.round(scale * 0.0013));
  context.save();
  for (const curve of curves) {
    if (curve.points.length < 2) {
      continue;
    }
    context.beginPath();
    const first = curve.points[0]!;
    context.moveTo(first.x, first.y);
    for (let i = 1; i < curve.points.length; i += 1) {
      const point = curve.points[i]!;
      context.lineTo(point.x, point.y);
    }
    strokeWithHalo(context, overlayInk(curve.color, invert), lineWidth, invert);
  }
  context.restore();
}

/**
 * Draw a label centred at (x, y) with an opaque backing so it stays legible over
 * the scene and visually "breaks" any measure line running beneath it. Returns
 * nothing; the backing colour follows the page (white when inverted).
 */
function drawOverlayLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  textColor: string,
  invert: boolean
): void {
  if (!text) {
    return;
  }
  context.save();
  context.font = `600 ${fontPx}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const padX = fontPx * 0.4;
  const padY = fontPx * 0.3;
  const textWidth = context.measureText(text).width;
  const boxW = textWidth + padX * 2;
  const boxH = fontPx + padY * 2;
  context.fillStyle = invert ? "rgba(255,255,255,0.85)" : "rgba(10,14,22,0.85)";
  context.fillRect(x - boxW / 2, y - boxH / 2, boxW, boxH);
  context.fillStyle = overlayInk(textColor, invert);
  context.fillText(text, x, y);
  context.restore();
}

/** Stroke projected dimensions/annotations and their value labels as vector graphics. */
function drawVectorDimensions(
  context: CanvasRenderingContext2D,
  dimensions: PrintOverlayDimension[],
  width: number,
  height: number,
  invert: boolean
): void {
  const scale = Math.min(width, height);
  const lineWidth = Math.max(1, Math.round(scale * 0.0013));
  for (const dim of dimensions) {
    context.save();
    context.beginPath();
    if (dim.kind === "measure") {
      // Extension feet then the full span; the label box knocks the line out.
      context.moveTo(dim.A.x, dim.A.y);
      context.lineTo(dim.m1.x, dim.m1.y);
      context.moveTo(dim.B.x, dim.B.y);
      context.lineTo(dim.m2.x, dim.m2.y);
      context.moveTo(dim.m1.x, dim.m1.y);
      context.lineTo(dim.m2.x, dim.m2.y);
      strokeWithHalo(context, overlayInk(dim.lineColor, invert), lineWidth, invert);
    } else if (dim.leader) {
      context.moveTo(dim.A.x, dim.A.y);
      context.lineTo(dim.labelPos.x, dim.labelPos.y);
      strokeWithHalo(context, overlayInk(dim.lineColor, invert), lineWidth, invert);
    }
    context.restore();
    drawOverlayLabel(context, dim.text, dim.labelPos.x, dim.labelPos.y, dim.fontPx, dim.textColor, invert);
  }
}

/**
 * Composite a rendered frame into a print-ready canvas: optional full-image
 * colour invert (dark editor background → white paper), an optional grid-aligned
 * edge ruler, a crisp vector grid, and a title block. The ruler/grid pitch
 * follows the scene grid when `gridMajorPitch`/`gridMinorPitch` are supplied.
 */
export function composePrintCanvas(args: {
  source: HTMLCanvasElement;
  settings: PrintSettings;
  pixelsPerMeter: number | null;
  gridMajorPitch?: number;
  gridMinorPitch?: number;
  gridMajorColor?: string;
  gridMinorColor?: string;
  gridOpacity?: number;
  ruler?: OrthoEdgeMapping | null;
  info?: { version: string; project: string; snapshot: string };
  /** Projected curve/dimension vector primitives to stroke onto the page. */
  overlay?: PrintVectorOverlay | null;
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

  // Crisp vector grid (axis-aligned ortho) — replaces the faint rasterised 3D grid.
  if (settings.showGrid && args.ruler) {
    drawVectorGrid(
      context,
      width,
      height,
      args.ruler,
      args.gridMajorPitch ?? 1,
      args.gridMinorPitch ?? 0.1,
      args.gridMajorColor ?? "#2f8f9d",
      args.gridMinorColor ?? "#1f2430",
      args.gridOpacity ?? 0.35,
      settings.invert
    );
  }

  // Vector curves & dimensions, projected to paper pixels by the print camera.
  if (args.overlay) {
    if (settings.showCurves && args.overlay.curves.length > 0) {
      drawVectorCurves(context, args.overlay.curves, width, height, settings.invert);
    }
    if (settings.showDimensions && args.overlay.dimensions.length > 0) {
      drawVectorDimensions(context, args.overlay.dimensions, width, height, settings.invert);
    }
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

  if (settings.showInfo && args.info) {
    // Sit the title block above the bottom ruler band when the 4-edge ruler is on.
    const band = settings.showRuler && args.ruler ? Math.max(18, Math.round(Math.min(width, height) * 0.022)) : 0;
    drawInfoBlock(context, width, height, settings.invert, args.info, band);
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

import type { PaperSize, PrintOrientation } from "@/features/print/types";

/**
 * Orthographic full view height in world units is `(half * 2) / zoom`. The
 * renderer and `viewUtils.ts` use a half-height of 8 (so the full span is 16);
 * `ORTHOGRAPHIC_HALF_HEIGHT` there is not exported, so we mirror the constant
 * here. Keep in sync with `src/features/camera/viewUtils.ts`.
 */
export const ORTHOGRAPHIC_VIEW_SPAN = 16;

const MM_PER_INCH = 25.4;

/** Paper dimensions in millimetres at portrait orientation (width × height). */
export const PAPER_SIZES_MM: Record<PaperSize, { wmm: number; hmm: number }> = {
  a4: { wmm: 210, hmm: 297 },
  a3: { wmm: 297, hmm: 420 }
};

export const PAPER_LABELS: Record<PaperSize, string> = {
  a4: "A4",
  a3: "A3"
};

/** Real:printed scale presets (e.g. 100 ⇒ 1:100, where 1 m prints as 1 cm). */
export const PRINT_SCALE_PRESETS: number[] = [1, 5, 10, 20, 50, 100, 200, 500, 1000];

export function paperDimensionsMm(paper: PaperSize, orientation: PrintOrientation): { wmm: number; hmm: number } {
  const base = PAPER_SIZES_MM[paper];
  if (orientation === "landscape") {
    return { wmm: base.hmm, hmm: base.wmm };
  }
  return { wmm: base.wmm, hmm: base.hmm };
}

export function paperPixelSize(
  paper: PaperSize,
  orientation: PrintOrientation,
  dpi: number
): { width: number; height: number } {
  const { wmm, hmm } = paperDimensionsMm(paper, orientation);
  const safeDpi = Math.max(1, dpi);
  return {
    width: Math.max(1, Math.round((wmm / MM_PER_INCH) * safeDpi)),
    height: Math.max(1, Math.round((hmm / MM_PER_INCH) * safeDpi))
  };
}

/**
 * World-space height (metres) that spans the full printed page height at the
 * given real:printed `ratio`. Example: A4 portrait (297 mm) at 1:100 spans
 * 0.297 m × 100 = 29.7 m.
 */
export function scaleToWorldViewHeight(paperHmm: number, ratio: number): number {
  return (paperHmm / 1000) * Math.max(1e-6, ratio);
}

/** Orthographic camera zoom that renders `worldViewHeight` metres across the page. */
export function zoomForWorldViewHeight(worldViewHeight: number): number {
  return ORTHOGRAPHIC_VIEW_SPAN / Math.max(1e-6, worldViewHeight);
}

export function zoomForPrintScale(paperHmm: number, ratio: number): number {
  return zoomForWorldViewHeight(scaleToWorldViewHeight(paperHmm, ratio));
}

export function pixelsPerMeter(pixelHeight: number, worldViewHeight: number): number {
  return pixelHeight / Math.max(1e-6, worldViewHeight);
}

export function formatScaleRatio(ratio: number): string {
  return `1:${ratio % 1 === 0 ? ratio.toString() : ratio.toFixed(2)}`;
}

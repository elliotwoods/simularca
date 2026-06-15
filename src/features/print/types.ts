export type PaperSize = "a4" | "a3";

export type PrintOrientation = "portrait" | "landscape";

/**
 * `fit` ignores physical scale and prints the current view to fit the page.
 * `ratio` prints at a true physical scale (only meaningful in orthographic
 * mode) where `scaleRatio` is the real:printed ratio (e.g. 100 ⇒ 1 m → 1 cm).
 */
export type PrintScaleMode = "fit" | "ratio";

export type PrintOutput = "dialog" | "pdf" | "png";

export interface PrintSettings {
  paper: PaperSize;
  orientation: PrintOrientation;
  dpi: number;
  invert: boolean;
  showRuler: boolean;
  scaleMode: PrintScaleMode;
  /** Real:printed ratio used when `scaleMode === "ratio"` (e.g. 100 = 1:100). */
  scaleRatio: number;
  output: PrintOutput;
}

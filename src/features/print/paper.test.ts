import { describe, expect, it } from "vitest";
import {
  paperDimensionsMm,
  paperPixelSize,
  pixelsPerMeter,
  scaleToWorldViewHeight,
  worldViewHeightFromZoom,
  zoomForPrintScale,
  zoomForWorldViewHeight,
  PAPER_SIZES_MM
} from "@/features/print/paper";

describe("print paper math", () => {
  it("defines A4 and A3 portrait dimensions", () => {
    expect(PAPER_SIZES_MM.a4).toEqual({ wmm: 210, hmm: 297 });
    expect(PAPER_SIZES_MM.a3).toEqual({ wmm: 297, hmm: 420 });
  });

  it("swaps dimensions for landscape orientation", () => {
    expect(paperDimensionsMm("a4", "portrait")).toEqual({ wmm: 210, hmm: 297 });
    expect(paperDimensionsMm("a4", "landscape")).toEqual({ wmm: 297, hmm: 210 });
  });

  it("computes pixel size at 300 dpi", () => {
    // A4 portrait: 210mm/25.4*300 ≈ 2480, 297mm/25.4*300 ≈ 3508
    expect(paperPixelSize("a4", "portrait", 300)).toEqual({ width: 2480, height: 3508 });
    // A3 landscape swaps to 420×297mm
    expect(paperPixelSize("a3", "landscape", 300)).toEqual({ width: 4961, height: 3508 });
  });

  it("derives world view height and zoom for a scale ratio", () => {
    const { hmm } = paperDimensionsMm("a4", "portrait");
    const worldViewHeight = scaleToWorldViewHeight(hmm, 100);
    // A4 portrait at 1:100 spans 0.297m * 100 = 29.7m
    expect(worldViewHeight).toBeCloseTo(29.7, 5);
    // zoom = 16 / 29.7 ≈ 0.5387
    expect(zoomForPrintScale(hmm, 100)).toBeCloseTo(16 / 29.7, 5);
  });

  it("produces a physically accurate pixels-per-meter at a known scale", () => {
    const { hmm } = paperDimensionsMm("a4", "portrait");
    const dpi = 300;
    const { height } = paperPixelSize("a4", "portrait", dpi);
    const worldViewHeight = scaleToWorldViewHeight(hmm, 100);
    const ppm = pixelsPerMeter(height, worldViewHeight);
    // At 1:100, one printed metre should measure 10mm on paper.
    const mmPerMeter = (ppm / dpi) * 25.4;
    expect(mmPerMeter).toBeCloseTo(10, 1);
  });

  it("inverts zoom <-> world view height", () => {
    // worldViewHeightFromZoom is the inverse of zoomForWorldViewHeight.
    expect(worldViewHeightFromZoom(zoomForWorldViewHeight(29.7))).toBeCloseTo(29.7, 5);
    expect(zoomForWorldViewHeight(worldViewHeightFromZoom(0.75))).toBeCloseTo(0.75, 5);
    // zoom 2 ⇒ 16/2 = 8m spans the page height.
    expect(worldViewHeightFromZoom(2)).toBeCloseTo(8, 5);
  });

  it("derives a fit-mode ruler scale directly from the camera zoom", () => {
    // In Fit to page the camera zoom is untouched; the ruler scale comes from it.
    const dpi = 300;
    const { height } = paperPixelSize("a4", "portrait", dpi);
    const zoom = 0.5; // 16/0.5 = 32m across the page height
    const ppm = pixelsPerMeter(height, worldViewHeightFromZoom(zoom));
    // 3508 px / 32 m ≈ 109.6 px per metre.
    expect(ppm).toBeCloseTo(height / 32, 4);
  });
});

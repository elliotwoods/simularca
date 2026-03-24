import type { RenderEngine } from "@/core/types";
import { canvasToPngBytes } from "@/features/render/exporters";

export interface ViewportScreenshotResult {
  pngBytes: Uint8Array;
  width: number;
  height: number;
  backend: RenderEngine;
}

export function assertViewportScreenshotSize(width: number, height: number): { width: number; height: number } {
  const safeWidth = Math.max(0, Math.round(width));
  const safeHeight = Math.max(0, Math.round(height));
  if (safeWidth <= 0 || safeHeight <= 0) {
    throw new Error("Viewport screenshot is unavailable because the viewport has no visible size.");
  }
  return {
    width: safeWidth,
    height: safeHeight
  };
}

export function formatViewportScreenshotStatus(result: ViewportScreenshotResult): string {
  return `Viewport screenshot copied to clipboard. ${result.width} x ${result.height} PNG | ${
    result.backend === "webgl2" ? "WEBGL2" : "WEBGPU"
  } | debug views hidden.`;
}

export async function captureViewportScreenshotFromCanvas(args: {
  backend: RenderEngine;
  canvas: HTMLCanvasElement;
}): Promise<ViewportScreenshotResult> {
  const width = Math.max(1, args.canvas.width);
  const height = Math.max(1, args.canvas.height);
  const stagingCanvas = document.createElement("canvas");
  stagingCanvas.width = width;
  stagingCanvas.height = height;
  const context = stagingCanvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create screenshot staging canvas.");
  }
  context.drawImage(args.canvas, 0, 0, width, height);
  return {
    pngBytes: await canvasToPngBytes(stagingCanvas),
    width,
    height,
    backend: args.backend
  };
}

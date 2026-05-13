import type { RenderEngine } from "@/core/types";
import { canvasToJpegBytes, canvasToPngBytes } from "@/features/render/exporters";

/** OpenGraph / social-card standard. Facebook, LinkedIn, Twitter all
 *  accept 1200 × 630 (1.91:1) and crop it cleanly. */
export const PUBLISH_THUMBNAIL_WIDTH = 1200;
export const PUBLISH_THUMBNAIL_HEIGHT = 630;
export const PUBLISH_THUMBNAIL_QUALITY = 0.85;
export const PUBLISH_THUMBNAIL_CONTENT_TYPE = "image/jpeg";

export interface ViewportThumbnailResult {
  jpegBytes: Uint8Array;
  width: number;
  height: number;
  contentType: string;
}

/**
 * Capture a viewport snapshot resized to the OpenGraph standard 1200×630
 * JPEG, ready to upload to R2 as a social-card image. Reuses the same
 * blank-frame retry pattern as `captureViewportScreenshotFromCanvas` so a
 * just-mounted WebGPU canvas doesn't return an empty image.
 */
export async function captureViewportThumbnail(args: {
  canvas: HTMLCanvasElement;
  width?: number;
  height?: number;
  quality?: number;
}): Promise<ViewportThumbnailResult> {
  const targetWidth = args.width ?? PUBLISH_THUMBNAIL_WIDTH;
  const targetHeight = args.height ?? PUBLISH_THUMBNAIL_HEIGHT;
  const quality = args.quality ?? PUBLISH_THUMBNAIL_QUALITY;

  const captureOnce = async (): Promise<ViewportThumbnailResult & { isBlank: boolean }> => {
    const width = Math.max(1, args.canvas.width);
    const height = Math.max(1, args.canvas.height);
    const stagingCanvas = document.createElement("canvas");
    stagingCanvas.width = width;
    stagingCanvas.height = height;
    const context = stagingCanvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create thumbnail staging canvas.");
    }
    context.drawImage(args.canvas, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const jpegBytes = await canvasToJpegBytes(
      stagingCanvas,
      { width: targetWidth, height: targetHeight },
      quality
    );
    return {
      jpegBytes,
      width: targetWidth,
      height: targetHeight,
      contentType: PUBLISH_THUMBNAIL_CONTENT_TYPE,
      isBlank: !hasOpaquePixel(imageData.data)
    };
  };

  const first = await captureOnce();
  if (!first.isBlank) {
    const { isBlank: _ignored, ...result } = first;
    return result;
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const second = await captureOnce();
  if (second.isBlank) {
    throw new Error("Viewport thumbnail is unavailable because the canvas is blank.");
  }
  const { isBlank: _ignored2, ...result } = second;
  return result;
}

export interface ViewportScreenshotResult {
  pngBytes: Uint8Array;
  width: number;
  height: number;
  backend: RenderEngine;
}

export function hasOpaquePixel(rgbaBytes: ArrayLike<number>): boolean {
  for (let index = 3; index < rgbaBytes.length; index += 4) {
    if ((rgbaBytes[index] ?? 0) !== 0) {
      return true;
    }
  }
  return false;
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
  const captureOnce = async (): Promise<ViewportScreenshotResult & { isBlank: boolean }> => {
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
    const imageData = context.getImageData(0, 0, width, height);
    return {
      pngBytes: await canvasToPngBytes(stagingCanvas),
      width,
      height,
      backend: args.backend,
      isBlank: !hasOpaquePixel(imageData.data)
    };
  };

  const firstCapture = await captureOnce();
  if (!firstCapture.isBlank) {
    return firstCapture;
  }

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const secondCapture = await captureOnce();
  if (secondCapture.isBlank) {
    throw new Error("Viewport screenshot is unavailable because the canvas is blank.");
  }
  return secondCapture;
}

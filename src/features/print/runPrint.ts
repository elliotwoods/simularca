import type { AppKernel } from "@/app/kernel";
import type { CameraState, RenderEngine, SceneColorBufferPrecision } from "@/core/types";
import { canvasToPngBytes } from "@/features/render/exporters";
import { composePrintCanvas } from "@/features/print/composePrint";
import {
  paperDimensionsMm,
  paperPixelSize,
  pixelsPerMeter,
  scaleToWorldViewHeight,
  zoomForPrintScale
} from "@/features/print/paper";
import type { PrintSettings } from "@/features/print/types";
import { WebGlViewport } from "@/render/webglRenderer";
import { WebGpuViewport } from "@/render/webgpuRenderer";

interface PrintViewportRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  renderOnce(): Promise<void>;
}

export interface PrintRenderContext {
  kernel: AppKernel;
  hostEl: HTMLElement;
  renderEngine: RenderEngine;
  antialias: boolean;
  colorBufferPrecision: SceneColorBufferPrecision;
  setMainViewportSuspended: (suspended: boolean) => void;
}

export interface RunPrintDeps extends PrintRenderContext {
  setStatus: (message: string) => void;
  projectName?: string;
}

export interface PrintFrameResult {
  canvas: HTMLCanvasElement;
  pixelsPerMeter: number | null;
}

function hasOpaquePixel(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) {
      return true;
    }
  }
  return false;
}

/** True when the canvas appears blank (fully transparent / nothing drawn yet). */
function canvasIsBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = Math.max(1, Math.min(canvas.width, 64));
  probe.height = Math.max(1, Math.min(canvas.height, 64));
  const ctx = probe.getContext("2d");
  if (!ctx) {
    return false;
  }
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  return !hasOpaquePixel(ctx.getImageData(0, 0, probe.width, probe.height).data);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to copy print frame.");
  }
  ctx.drawImage(source, 0, 0);
  return copy;
}

function triggerPngDownload(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render the current scene offscreen at paper resolution (or a reduced preview
 * size) using the print camera, and return the raw rendered frame plus the
 * ruler scale. Mirrors the offscreen-viewport lifecycle used by `runRender`
 * but renders a single frame.
 *
 * Touches the store camera only while the offscreen viewport renders, then
 * restores it. Pass `suspendMain` for the full export so the live viewport
 * releases its GPU resources; preview renders leave the live viewport running.
 */
export async function renderPrintFrame(
  settings: PrintSettings,
  ctx: PrintRenderContext,
  opts?: { maxPx?: number; suspendMain?: boolean }
): Promise<PrintFrameResult> {
  const store = ctx.kernel.store;
  const previousCamera = structuredClone(store.getState().state.camera);
  const full = paperPixelSize(settings.paper, settings.orientation, settings.dpi);
  const { hmm } = paperDimensionsMm(settings.paper, settings.orientation);

  let width = full.width;
  let height = full.height;
  if (opts?.maxPx && Math.max(width, height) > opts.maxPx) {
    const scale = opts.maxPx / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const useScale = settings.scaleMode === "ratio" && previousCamera.mode === "orthographic";
  const printCamera: CameraState = useScale
    ? { ...previousCamera, zoom: zoomForPrintScale(hmm, settings.scaleRatio) }
    : previousCamera;
  const ppm =
    settings.showRuler && useScale
      ? pixelsPerMeter(height, scaleToWorldViewHeight(hmm, settings.scaleRatio))
      : null;

  if (opts?.suspendMain) {
    ctx.setMainViewportSuspended(true);
  }
  const hostEl = ctx.hostEl;
  hostEl.style.width = `${String(width)}px`;
  hostEl.style.height = `${String(height)}px`;

  let viewport: PrintViewportRuntime | null = null;
  try {
    const options = {
      antialias: ctx.antialias,
      colorBufferPrecision: ctx.colorBufferPrecision,
      qualityMode: "export" as const,
      manualFrameControl: true,
      showDebugHelpers: false,
      editorOverlays: false,
      viewportSize: { width, height }
    };
    viewport =
      ctx.renderEngine === "webgl2"
        ? new WebGlViewport(ctx.kernel, hostEl, options)
        : new WebGpuViewport(ctx.kernel, hostEl, options);

    store.getState().actions.setCameraState(printCamera, false, { rememberPerspective: false });
    await viewport.start();
    await viewport.renderOnce();

    let canvas = hostEl.querySelector("canvas");
    if (canvas instanceof HTMLCanvasElement && canvasIsBlank(canvas)) {
      await nextFrame();
      await viewport.renderOnce();
      canvas = hostEl.querySelector("canvas");
    }
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Print render canvas is unavailable.");
    }
    // Copy out before the viewport is torn down (which disposes the GL canvas).
    return { canvas: copyCanvas(canvas), pixelsPerMeter: ppm };
  } finally {
    if (viewport) {
      await viewport.stop();
    }
    store.getState().actions.setCameraState(previousCamera, false, { rememberPerspective: false });
    if (opts?.suspendMain) {
      ctx.setMainViewportSuspended(false);
    }
  }
}

/**
 * Full print pipeline: render the scene offscreen at paper resolution,
 * composite invert + ruler, and deliver via OS print dialog, a saved PDF, or
 * a downloaded PNG.
 */
export async function runPrint(settings: PrintSettings, deps: RunPrintDeps): Promise<void> {
  deps.setStatus("Preparing print...");
  try {
    const { canvas, pixelsPerMeter: ppm } = await renderPrintFrame(settings, deps, { suspendMain: true });
    const composed = composePrintCanvas({ source: canvas, settings, pixelsPerMeter: ppm });
    const pngBytes = await canvasToPngBytes(composed);
    const baseName = (deps.projectName ?? "print").replace(/[^\w.-]+/g, "_") || "print";

    if (settings.output === "png") {
      triggerPngDownload(pngBytes, `${baseName}.png`);
      deps.setStatus(`Print image saved. ${composed.width} x ${composed.height} PNG.`);
      return;
    }
    if (settings.output === "pdf") {
      const api = window.electronAPI;
      if (!api?.printPagePdf) {
        throw new Error("PDF export is only available in the desktop app.");
      }
      const result = await api.printPagePdf({
        pngBytes,
        paper: settings.paper,
        landscape: settings.orientation === "landscape",
        defaultFileName: `${baseName}.pdf`
      });
      deps.setStatus(result?.path ? `Print saved to ${result.path}` : "Print PDF cancelled.");
      return;
    }
    const api = window.electronAPI;
    if (!api?.printPageDialog) {
      throw new Error("Printing is only available in the desktop app.");
    }
    await api.printPageDialog({
      pngBytes,
      paper: settings.paper,
      landscape: settings.orientation === "landscape"
    });
    deps.setStatus("Sent to printer.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown print failure";
    deps.setStatus(`Print failed: ${message}`);
  }
}

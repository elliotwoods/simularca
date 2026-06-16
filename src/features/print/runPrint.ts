import { BUILD_INFO } from "@/app/buildInfo";
import type { AppKernel } from "@/app/kernel";
import type { CameraState, RenderEngine, SceneColorBufferPrecision } from "@/core/types";
import {
  computeOrthoEdgeMapping,
  createWorldToPaperProjector,
  type OrthoEdgeMapping
} from "@/features/camera/viewUtils";
import { canvasToPngBytes } from "@/features/render/exporters";
import { composePrintCanvas, isCanvasMostlyDark } from "@/features/print/composePrint";
import { buildPrintVectorOverlay, type PrintVectorOverlay } from "@/features/print/printVectorOverlay";
import {
  paperDimensionsMm,
  paperPixelSize,
  pixelsPerMeter,
  scaleToWorldViewHeight,
  worldViewHeightFromZoom,
  zoomForPrintScale
} from "@/features/print/paper";
import type { PrintSettings } from "@/features/print/types";
import type { SceneController } from "@/render/sceneController";
import { WebGlViewport } from "@/render/webglRenderer";
import { WebGpuViewport } from "@/render/webgpuRenderer";

interface PrintViewportRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  renderOnce(): Promise<void>;
  getSceneController(): SceneController;
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
  gridMajorPitch: number;
  gridMinorPitch: number;
  gridMajorColor: string;
  gridMinorColor: string;
  gridOpacity: number;
  mostlyDark: boolean;
  /** World↔edge mapping for the grid-aligned ruler (null for non-aligned views). */
  ruler: OrthoEdgeMapping | null;
  /** Title-block strings (version/project/snapshot). */
  info: { version: string; project: string; snapshot: string };
  /** Curve/dimension vector primitives projected to paper pixels for this frame. */
  overlay: PrintVectorOverlay;
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

/**
 * True while any actor reports an in-progress async load (e.g. the DXF plugin
 * reading its asset). The offscreen print viewport builds its own actor
 * controllers, so their loads must settle before we capture the frame.
 */
function anyActorLoading(store: AppKernel["store"]): boolean {
  const statuses = store.getState().state.actorStatusByActorId;
  for (const status of Object.values(statuses)) {
    if (status.values.loadState === "loading") {
      return true;
    }
  }
  return false;
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

  const orthographic = previousCamera.mode === "orthographic";
  const useScale = settings.scaleMode === "ratio" && orthographic;
  const printCamera: CameraState = useScale
    ? { ...previousCamera, zoom: zoomForPrintScale(hmm, settings.scaleRatio) }
    : previousCamera;
  // The ruler scale is known for any orthographic view: in ratio mode it comes
  // from the chosen scale, in fit mode from the (untouched) camera zoom. Compute
  // it regardless of `showRuler` so toggling the ruler needs no 3D re-render.
  const worldViewHeight = !orthographic
    ? null
    : useScale
      ? scaleToWorldViewHeight(hmm, settings.scaleRatio)
      : worldViewHeightFromZoom(previousCamera.zoom);
  const ppm = worldViewHeight === null ? null : pixelsPerMeter(height, worldViewHeight);
  // World↔edge mapping for the grid-aligned ruler. Uses the same projection the
  // offscreen viewport will (paper aspect + print camera), so ticks line up with
  // the grid. Null for non-axis-aligned ortho → the relative ruler is used.
  const ruler = computeOrthoEdgeMapping(printCamera, width / height);

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
      // Keep generic debug helpers off; the grid/origin are driven explicitly by
      // the per-viewport overrides so they appear without other debug clutter.
      showDebugHelpers: false,
      editorOverlays: settings.showOverlays,
      // Axis-aligned ortho (ruler present) draws a crisp vector grid in the
      // compositor, so suppress the 3D grid there to avoid a faint double grid;
      // keep the 3D grid only as the non-aligned fallback.
      gridVisibleOverride: settings.showGrid && ruler === null,
      axesVisibleOverride: settings.showOrigin,
      viewportSize: { width, height }
    };
    viewport =
      ctx.renderEngine === "webgl2"
        ? new WebGlViewport(ctx.kernel, hostEl, options)
        : new WebGpuViewport(ctx.kernel, hostEl, options);

    store.getState().actions.setCameraState(printCamera, false, { rememberPerspective: false });
    await viewport.start();
    // First frame triggers each actor's sync()/async asset load (e.g. DXF).
    await viewport.renderOnce();

    // Settle: keep rendering until async actor loads resolve and the canvas has
    // content. Bounded by a deadline so a stuck/failed load can never hang us.
    const SETTLE_DEADLINE_MS = 2500;
    const SETTLE_MAX_ITERATIONS = 60;
    const deadline = Date.now() + SETTLE_DEADLINE_MS;
    let canvas = hostEl.querySelector("canvas");
    for (let i = 0; i < SETTLE_MAX_ITERATIONS; i += 1) {
      const loading = anyActorLoading(store);
      const blank = !(canvas instanceof HTMLCanvasElement) || canvasIsBlank(canvas);
      if ((!loading && !blank) || Date.now() > deadline) {
        break;
      }
      await nextFrame();
      await viewport.renderOnce();
      canvas = hostEl.querySelector("canvas");
    }
    // One more frame so geometry built on the sync() that follows a just-completed
    // async load (e.g. parsed DXF) is actually drawn before we copy the canvas.
    await viewport.renderOnce();
    canvas = hostEl.querySelector("canvas");

    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Print render canvas is unavailable.");
    }
    // Copy out before the viewport is torn down (which disposes the GL canvas).
    const out = copyCanvas(canvas);
    const appState = store.getState().state;
    const grid = appState.scene.helpers.grid;
    // Project curves & dimensions to paper pixels while the offscreen scene (and
    // its actor world transforms) is still alive, using the same print camera.
    const overlay = buildPrintVectorOverlay({
      state: appState,
      scene: viewport.getSceneController(),
      project: createWorldToPaperProjector(printCamera, width, height),
      width,
      height
    });
    return {
      canvas: out,
      pixelsPerMeter: ppm,
      overlay,
      gridMajorPitch: grid.majorPitch,
      gridMinorPitch: grid.minorPitch,
      gridMajorColor: grid.majorColor,
      gridMinorColor: grid.minorColor,
      gridOpacity: grid.opacity,
      mostlyDark: isCanvasMostlyDark(out),
      ruler,
      info: {
        version: BUILD_INFO.version,
        project: appState.activeProject?.name ?? "",
        snapshot: appState.activeSnapshotName
      }
    };
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
    const frame = await renderPrintFrame(settings, deps, { suspendMain: true });
    const composed = composePrintCanvas({
      source: frame.canvas,
      settings,
      pixelsPerMeter: frame.pixelsPerMeter,
      gridMajorPitch: frame.gridMajorPitch,
      gridMinorPitch: frame.gridMinorPitch,
      gridMajorColor: frame.gridMajorColor,
      gridMinorColor: frame.gridMinorColor,
      gridOpacity: frame.gridOpacity,
      ruler: frame.ruler,
      info: frame.info,
      overlay: frame.overlay
    });
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

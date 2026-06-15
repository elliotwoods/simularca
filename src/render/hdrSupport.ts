// Runtime feature detection + canvas configuration for HDR output.
//
// "HDR output" here means brighter-than-white (extended-range) compositing plus the
// Display-P3 wide gamut, delivered via the WebGPU canvas. This relies on Chromium's
// `GPUCanvasContext.configure({ toneMapping: { mode: "extended" }, ... })`
// (Chrome/Electron 121+) and is WebGPU-only — WebGL2 has no equivalent path.

let cachedSupport: boolean | null = null;

/**
 * Best-effort static capability check, used to gate the UI toggle before a renderer
 * exists. WebGPU must be present and `GPUTextureUsage` available. The authoritative
 * check happens at configure time (see {@link configureCanvasForHdr}), which falls
 * back gracefully if the runtime rejects the extended tone-mapping configuration.
 */
export function isHdrOutputSupported(): boolean {
  if (cachedSupport !== null) {
    return cachedSupport;
  }
  cachedSupport =
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    typeof GPUTextureUsage !== "undefined";
  return cachedSupport;
}

/**
 * Reconfigure an existing WebGPU canvas context for HDR output. Returns `true` when
 * the HDR configuration was applied, `false` when the runtime rejected it (in which
 * case the caller should keep the renderer's default SDR configuration).
 *
 * `usage` and `alphaMode` mirror the Three.js WebGPUBackend defaults so COPY_SRC
 * dependent features (screenshots, readback) keep working.
 */
export function configureCanvasForHdr(
  context: GPUCanvasContext,
  device: GPUDevice
): boolean {
  try {
    context.configure({
      device,
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: "opaque",
      colorSpace: "display-p3",
      // `toneMapping` is the newer extended-range field; not in older type defs.
      toneMapping: { mode: "extended" }
    } as GPUCanvasConfiguration & { toneMapping: { mode: "extended" } });
    return true;
  } catch {
    cachedSupport = false;
    return false;
  }
}

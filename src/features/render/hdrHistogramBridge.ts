// Tiny singleton bridge that lets the HDR Preview panel receive a live luminance
// histogram of the viewport without prop-drilling through App → FlexLayoutHost →
// ViewportPanel. The panel subscribes (which enables sampling); the viewport checks
// `isHdrHistogramEnabled()` each frame and, when watched, publishes a fresh result.
//
// Kept module-local on purpose — there is only ever one active viewport in the editor
// process (same rationale as viewportThumbnailBridge.ts).

// Number of histogram bins spanning [0, HDR_HISTOGRAM_MAX]. Values above the max land in
// a separate `overflow` count. HDR_HISTOGRAM_MAX matches the gradient test pattern's
// horizontal scale so the two views share the same 0–4× luminance axis.
export const HDR_HISTOGRAM_BINS = 128;
export const HDR_HISTOGRAM_MAX = 4.0;

export interface HdrHistogramResult {
  /** Per-bin sample counts across [0, HDR_HISTOGRAM_MAX], length HDR_HISTOGRAM_BINS. */
  bins: Uint32Array;
  /** Samples whose luminance exceeded HDR_HISTOGRAM_MAX. */
  overflow: number;
  /** Total samples counted (after stride sampling). */
  totalSamples: number;
  /** Highest single-sample linear luminance seen (unclamped, in × SDR white). */
  peakLuminance: number;
  /** Fraction of samples with luminance > 1.0 (i.e. into HDR range). */
  fractionHdr: number;
  /** True when the source canvas was a floating-point (HDR-capable) format. */
  isFloat: boolean;
}

type Listener = (result: HdrHistogramResult) => void;

const listeners = new Set<Listener>();
let latest: HdrHistogramResult | null = null;

/**
 * Subscribe to live histogram updates. While at least one subscriber is registered the
 * viewport performs the per-frame readback; the returned function unsubscribes (and, when
 * it was the last subscriber, disables sampling). If a result already exists it is
 * delivered immediately.
 */
export function subscribeHdrHistogram(listener: Listener): () => void {
  listeners.add(listener);
  if (latest) {
    listener(latest);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function isHdrHistogramEnabled(): boolean {
  return listeners.size > 0;
}

export function publishHdrHistogram(result: HdrHistogramResult): void {
  latest = result;
  for (const listener of listeners) {
    listener(result);
  }
}

export function getLatestHdrHistogram(): HdrHistogramResult | null {
  return latest;
}

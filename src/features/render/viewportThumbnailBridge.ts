import type { ViewportThumbnailResult } from "@/features/render/viewportScreenshot";

/**
 * Tiny singleton-style bridge that lets non-viewport UI (e.g. PublishModal)
 * ask the live viewport for a thumbnail without prop-drilling a callback
 * through App → FlexLayoutHost → ViewportPanel. ViewportPanel registers
 * itself on mount; PublishModal calls `captureActiveThumbnail()`.
 *
 * Kept module-local on purpose — there's only ever one active viewport at
 * a time in the editor process. If we ever need multi-viewport support
 * this becomes a registry keyed on viewport id.
 */

type ThumbnailCapturer = () => Promise<ViewportThumbnailResult>;

let activeCapturer: ThumbnailCapturer | null = null;

/**
 * Register the active viewport's thumbnail capturer. Pass `null` on
 * unmount so a closed viewport can't be re-entered after disposal.
 */
export function registerThumbnailCapturer(capturer: ThumbnailCapturer | null): void {
  activeCapturer = capturer;
}

export function hasActiveThumbnailCapturer(): boolean {
  return activeCapturer !== null;
}

export async function captureActiveThumbnail(): Promise<ViewportThumbnailResult> {
  if (!activeCapturer) {
    throw new Error("Viewport is not ready for thumbnail capture.");
  }
  return activeCapturer();
}

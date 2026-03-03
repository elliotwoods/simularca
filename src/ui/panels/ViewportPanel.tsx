import { useEffect, useRef, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { WebGpuViewport } from "@/render/webgpuRenderer";

export function ViewportPanel() {
  const kernel = useKernel();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<WebGpuViewport | null>(null);
  const hideOverlayTimeoutRef = useRef<number | null>(null);
  const resizeObservedElementsRef = useRef<HTMLElement[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [showResolutionOverlay, setShowResolutionOverlay] = useState(false);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }
    const viewport = new WebGpuViewport(kernel, hostRef.current);
    viewportRef.current = viewport;
    let cancelled = false;
    void viewport.start().catch((error) => {
      if (cancelled) {
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown WebGPU startup error.";
      kernel.store.getState().actions.setStatus(`Viewport startup failed: ${message}`);
    });
    return () => {
      cancelled = true;
      viewport.stop();
      viewportRef.current = null;
    };
  }, [kernel]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }
    const hostEl = hostRef.current;
    const collectObservedElements = (): HTMLElement[] => {
      const elements: HTMLElement[] = [];
      const seen = new Set<HTMLElement>();
      let node: HTMLElement | null = hostEl;
      for (let depth = 0; node && depth < 8; depth += 1) {
        if (!seen.has(node)) {
          seen.add(node);
          elements.push(node);
        }
        if (
          node.classList.contains("flexlayout__tabset_content") ||
          node.classList.contains("flexlayout__tabset_container") ||
          node.classList.contains("flexlayout__layout")
        ) {
          break;
        }
        node = node.parentElement;
      }
      return elements;
    };
    const getEffectiveViewportSize = (): { width: number; height: number } => {
      const elements = resizeObservedElementsRef.current.length > 0 ? resizeObservedElementsRef.current : [hostEl];
      const measurementElements = elements.length > 1 ? elements.slice(1) : elements;
      let width = Number.POSITIVE_INFINITY;
      let height = Number.POSITIVE_INFINITY;
      for (const element of measurementElements) {
        width = Math.min(width, Math.max(1, Math.round(element.clientWidth)));
        height = Math.min(height, Math.max(1, Math.round(element.clientHeight)));
      }
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return {
          width: Math.max(1, Math.round(hostEl.clientWidth)),
          height: Math.max(1, Math.round(hostEl.clientHeight))
        };
      }
      return { width, height };
    };
    const onResize = () => {
      const { width, height } = getEffectiveViewportSize();
      setViewportSize({ width, height });
      setShowResolutionOverlay(true);
      if (hideOverlayTimeoutRef.current !== null) {
        window.clearTimeout(hideOverlayTimeoutRef.current);
      }
      hideOverlayTimeoutRef.current = window.setTimeout(() => {
        setShowResolutionOverlay(false);
        hideOverlayTimeoutRef.current = null;
      }, 320);
    };
    const observer = new ResizeObserver(onResize);
    resizeObservedElementsRef.current = collectObservedElements();
    for (const element of resizeObservedElementsRef.current) {
      observer.observe(element);
    }
    const onWindowResize = () => onResize();
    window.addEventListener("resize", onWindowResize);
    onResize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      resizeObservedElementsRef.current = [];
      if (hideOverlayTimeoutRef.current !== null) {
        window.clearTimeout(hideOverlayTimeoutRef.current);
        hideOverlayTimeoutRef.current = null;
      }
    };
  }, []);

  return (
    <div className="viewport-panel">
      <div className="viewport-canvas-host" ref={hostRef} />
      <div className={`viewport-resolution-overlay${showResolutionOverlay ? " is-visible" : ""}`}>
        {viewportSize.width} x {viewportSize.height}
      </div>
    </div>
  );
}


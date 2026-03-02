import { useEffect, useRef } from "react";
import { useKernel } from "@/app/useKernel";
import { WebGpuViewport } from "@/render/webgpuRenderer";

export function ViewportPanel() {
  const kernel = useKernel();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<WebGpuViewport | null>(null);

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

  return (
    <div className="viewport-panel">
      <div className="viewport-canvas-host" ref={hostRef} />
    </div>
  );
}


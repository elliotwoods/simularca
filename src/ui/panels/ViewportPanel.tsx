import { useEffect, useRef, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorTransformMode } from "@/render/actorTransformController";
import { WebGpuViewport } from "@/render/webgpuRenderer";
import { WebGlViewport } from "@/render/webglRenderer";

interface ViewportRuntime {
  start(): Promise<void>;
  stop(): void;
  setActorTransformMode(mode: ActorTransformMode): void;
}

interface ViewportPanelProps {
  suspended?: boolean;
}

export function ViewportPanel(props: ViewportPanelProps) {
  const kernel = useKernel();
  const backend = useAppStore((store) => store.state.scene.renderEngine);
  const antialiasing = useAppStore((store) => store.state.scene.antialiasing);
  // Returns a stable string so Zustand's reference equality check avoids spurious re-renders.
  const loadingBannerText = useAppStore((store) => {
    const statuses = store.state.actorStatusByActorId;
    const actors = store.state.actors;
    const names: string[] = [];
    for (const [actorId, s] of Object.entries(statuses)) {
      if (s.values.loadState !== "loading") continue;
      const fileName = s.values.assetFileName;
      names.push(typeof fileName === "string" ? fileName : (actors[actorId]?.name ?? "asset"));
    }
    if (names.length === 0) return "";
    if (names.length === 1) return names[0]!;
    return `${names.length} assets`;
  });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<ViewportRuntime | null>(null);
  const hideOverlayTimeoutRef = useRef<number | null>(null);
  const resizeObservedElementsRef = useRef<HTMLElement[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [showResolutionOverlay, setShowResolutionOverlay] = useState(false);
  const [actorTransformMode, setActorTransformMode] = useState<ActorTransformMode>("translate");

  useEffect(() => {
    if (props.suspended) {
      return;
    }
    if (!hostRef.current) {
      return;
    }
    const viewport: ViewportRuntime =
      backend === "webgl2"
        ? new WebGlViewport(kernel, hostRef.current, { antialias: antialiasing })
        : new WebGpuViewport(kernel, hostRef.current, { antialias: antialiasing });
    viewport.setActorTransformMode(actorTransformMode);
    viewportRef.current = viewport;
    let cancelled = false;
    void viewport.start().catch((error) => {
      if (cancelled) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : `Unknown ${backend === "webgl2" ? "WebGL2" : "WebGPU"} startup error.`;
      kernel.store.getState().actions.setStatus(`Viewport startup failed: ${message}`);
    });
    return () => {
      cancelled = true;
      viewport.stop();
      viewportRef.current = null;
    };
  }, [antialiasing, backend, kernel, props.suspended]);

  useEffect(() => {
    viewportRef.current?.setActorTransformMode(actorTransformMode);
  }, [actorTransformMode]);

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
      {!props.suspended ? (
        <div className="viewport-transform-toolbar" role="toolbar" aria-label="Actor transform mode">
          <button
            type="button"
            className={`viewport-transform-button${actorTransformMode === "translate" ? " is-active" : ""}`}
            onClick={() => setActorTransformMode("translate")}
            title="Translate selected actor"
          >
            Move
          </button>
          <button
            type="button"
            className={`viewport-transform-button${actorTransformMode === "rotate" ? " is-active" : ""}`}
            onClick={() => setActorTransformMode("rotate")}
            title="Rotate selected actor"
          >
            Rotate
          </button>
        </div>
      ) : null}
      {props.suspended ? <div className="viewport-suspended-overlay">Viewport suspended during render</div> : null}
      {loadingBannerText && !props.suspended ? (
        <div className="viewport-loading-banner">
          <span className="viewport-loading-spinner" />
          Loading {loadingBannerText}&ensp;&mdash;&ensp;window may be unresponsive
        </div>
      ) : null}
      <div className={`viewport-resolution-overlay${showResolutionOverlay ? " is-visible" : ""}`}>
        {viewportSize.width} x {viewportSize.height} ({backend === "webgl2" ? "WEBGL2" : "WEBGPU"})
      </div>
    </div>
  );
}

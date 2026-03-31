import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnet, faMaximize, faRotateRight, faUpDownLeftRight } from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { CameraState, SceneFramePacingSettings } from "@/core/types";
import {
  cameraStateForViewDirection,
  flipCameraAroundTarget,
  getCameraForward,
  getViewDirectionVector,
  orbitCameraFromPointerDelta,
  projectWorldDirectionsAtViewportCenter,
  resolveRepeatedDirectionalShortcut,
  stepOrbitAroundTarget,
  toggleCameraProjectionMode,
  type CameraViewDirection
} from "@/features/camera/viewUtils";
import { DEFAULT_CAMERA_TRANSITION_DURATION_MS } from "@/features/camera/transitionController";
import {
  formatViewportScreenshotStatus,
  type ViewportScreenshotResult
} from "@/features/render/viewportScreenshot";
import type { ActorTransformMode } from "@/render/actorTransformController";
import { WebGpuViewport } from "@/render/webgpuRenderer";
import { WebGlViewport } from "@/render/webglRenderer";

interface ViewportRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  captureViewportScreenshot(requestSize: { width: number; height: number }): Promise<ViewportScreenshotResult>;
  setActorTransformMode(mode: ActorTransformMode): void;
  setActorTransformSnappingEnabled(enabled: boolean): void;
  setFramePacing(settings: SceneFramePacingSettings): void;
}

interface ViewportPanelProps {
  suspended?: boolean;
  screenshotRequestId?: number;
  onScreenshotBusyChange?: (busy: boolean) => void;
}

type WidgetAxis = "x" | "y" | "z";

interface AxisHandleConfig {
  id: string;
  label: string;
  vector: THREE.Vector3;
  view: CameraViewDirection;
  axis: WidgetAxis;
  negative: boolean;
}

const AXES_WIDGET_RADIUS = 45;
const VIEW_SHORTCUT_ROTATION_STEP = Math.PI / 12;

const AXIS_HANDLES: AxisHandleConfig[] = [
  { id: "pos-x", label: "+X", vector: new THREE.Vector3(1, 0, 0), view: "right", axis: "x", negative: false },
  { id: "neg-x", label: "-X", vector: new THREE.Vector3(-1, 0, 0), view: "left", axis: "x", negative: true },
  { id: "pos-y", label: "+Y", vector: new THREE.Vector3(0, 1, 0), view: "top", axis: "y", negative: false },
  { id: "neg-y", label: "-Y", vector: new THREE.Vector3(0, -1, 0), view: "bottom", axis: "y", negative: true },
  { id: "pos-z", label: "+Z", vector: new THREE.Vector3(0, 0, 1), view: "front", axis: "z", negative: false },
  { id: "neg-z", label: "-Z", vector: new THREE.Vector3(0, 0, -1), view: "back", axis: "z", negative: true }
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function setGlobalAxesDragMode(active: boolean): void {
  const className = "is-dragging-viewport-axes";
  if (active) {
    document.body.classList.add(className);
    return;
  }
  document.body.classList.remove(className);
}

function getAxisHandleLayout(camera: CameraState, viewportSize: { width: number; height: number }) {
  const aspect = viewportSize.width > 0 && viewportSize.height > 0 ? viewportSize.width / viewportSize.height : 1;
  const projectedDirections = projectWorldDirectionsAtViewportCenter(
    camera,
    aspect,
    AXIS_HANDLES.map((handle) => handle.vector)
  );
  const maxScreenDistance =
    projectedDirections.reduce((maxValue, entry) => Math.max(maxValue, entry.screen.length()), 0) || 1;
  const scale = AXES_WIDGET_RADIUS / maxScreenDistance;
  return AXIS_HANDLES.map((handle, index) => {
    const projected = projectedDirections[index]!;
    return {
      ...handle,
      depth: projected.depth,
      left: projected.screen.x * scale,
      top: -projected.screen.y * scale
    };
  }).sort((a, b) => b.depth - a.depth);
}

function depthToZIndex(depth: number): number {
  const normalizedDepth = Math.max(-1, Math.min(1, depth));
  // Front-facing handles land at negative depth and should render above rear-facing handles.
  return 50 + Math.round((1 - normalizedDepth) * 20);
}

function applyDirectionalShortcut(
  camera: CameraState,
  rememberedPerspectiveCamera: CameraState | null,
  digit: "1" | "3" | "7"
): CameraState {
  switch (digit) {
    case "1":
      return cameraStateForViewDirection(
        camera,
        resolveRepeatedDirectionalShortcut(camera, "front", "back"),
        "orthographic",
        rememberedPerspectiveCamera
      );
    case "3":
      return cameraStateForViewDirection(
        camera,
        resolveRepeatedDirectionalShortcut(camera, "right", "left"),
        "orthographic",
        rememberedPerspectiveCamera
      );
    case "7":
      return cameraStateForViewDirection(
        camera,
        resolveRepeatedDirectionalShortcut(camera, "top", "bottom"),
        "orthographic",
        rememberedPerspectiveCamera
      );
  }
}

function applyOrbitShortcut(camera: CameraState, digit: "2" | "4" | "6" | "8"): CameraState {
  switch (digit) {
    case "2":
      return stepOrbitAroundTarget(camera, 0, VIEW_SHORTCUT_ROTATION_STEP);
    case "4":
      return stepOrbitAroundTarget(camera, -VIEW_SHORTCUT_ROTATION_STEP, 0);
    case "6":
      return stepOrbitAroundTarget(camera, VIEW_SHORTCUT_ROTATION_STEP, 0);
    case "8":
      return stepOrbitAroundTarget(camera, 0, -VIEW_SHORTCUT_ROTATION_STEP);
  }
}

function normalizeViewportShortcut(event: KeyboardEvent): string | null {
  switch (event.code) {
    case "Digit1":
    case "Numpad1":
      return "1";
    case "Digit2":
    case "Numpad2":
      return "2";
    case "Digit3":
    case "Numpad3":
      return "3";
    case "Digit4":
    case "Numpad4":
      return "4";
    case "Digit5":
    case "Numpad5":
      return "5";
    case "Digit6":
    case "Numpad6":
      return "6";
    case "Digit7":
    case "Numpad7":
      return "7";
    case "Digit8":
    case "Numpad8":
      return "8";
    case "Digit9":
    case "Numpad9":
      return "9";
    default:
      return null;
  }
}

export function ViewportPanel(props: ViewportPanelProps) {
  const kernel = useKernel();
  const backend = useAppStore((store) => store.state.scene.renderEngine);
  const antialiasing = useAppStore((store) => store.state.scene.antialiasing);
  const framePacing = useAppStore((store) => store.state.scene.framePacing);
  const camera = useAppStore((store) => store.state.camera);
  const rememberedPerspectiveCamera = useAppStore((store) => store.state.lastPerspectiveCamera);
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
  const axesHitAreaRef = useRef<HTMLDivElement | null>(null);
  const hideOverlayTimeoutRef = useRef<number | null>(null);
  const resizeObservedElementsRef = useRef<HTMLElement[]>([]);
  const viewportHoveredRef = useRef(false);
  const cameraRef = useRef(camera);
  const cleanupAxesDragRef = useRef<(() => void) | null>(null);
  const screenshotInFlightRef = useRef(false);
  const lastScreenshotRequestIdRef = useRef(props.screenshotRequestId ?? 0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [showResolutionOverlay, setShowResolutionOverlay] = useState(false);
  const [actorTransformMode, setActorTransformMode] = useState<ActorTransformMode>("none");
  const [actorTransformSnapToggled, setActorTransformSnapToggled] = useState(true);
  const [actorTransformSnapShiftOverride, setActorTransformSnapShiftOverride] = useState(false);
  const [viewportHovered, setViewportHovered] = useState(false);
  const [axesDragging, setAxesDragging] = useState(false);
  const actorTransformSnappingEnabled = actorTransformSnapToggled !== actorTransformSnapShiftOverride;
  const axisHandles = getAxisHandleLayout(camera, viewportSize);

  cameraRef.current = camera;
  viewportHoveredRef.current = viewportHovered;

  const requestCamera = (nextCamera: CameraState) => {
    kernel.store.getState().actions.requestCameraState(nextCamera, {
      animated: true,
      durationMs: DEFAULT_CAMERA_TRANSITION_DURATION_MS,
      markDirty: true
    });
  };

  const setCameraImmediate = (nextCamera: CameraState) => {
    kernel.store.getState().actions.cancelCameraTransition();
    kernel.store.getState().actions.setCameraState(nextCamera, true);
  };

  const startAxesDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!axesHitAreaRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    kernel.store.getState().actions.cancelCameraTransition();

    cleanupAxesDragRef.current?.();

    const root = axesHitAreaRef.current;
    let disposed = false;
    let lockAcquired = false;

    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (document.pointerLockElement === root) {
        document.exitPointerLock();
      }
      setGlobalAxesDragMode(false);
      setAxesDragging(false);
      cleanupAxesDragRef.current = null;
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!lockAcquired) {
        return;
      }
      const deltaX = Number.isFinite(moveEvent.movementX) ? moveEvent.movementX : 0;
      const deltaY = Number.isFinite(moveEvent.movementY) ? moveEvent.movementY : 0;
      if (deltaX === 0 && deltaY === 0) {
        return;
      }
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      setCameraImmediate(
        orbitCameraFromPointerDelta(cameraRef.current, deltaX, deltaY, Math.max(1, root.clientHeight))
      );
    };

    const onMouseUp = () => {
      cleanup();
    };

    const onBlur = () => {
      cleanup();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        cleanup();
      }
    };

    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") {
        return;
      }
      keyboardEvent.preventDefault();
      cleanup();
    };

    const onPointerLockChange = () => {
      if (document.pointerLockElement === root) {
        lockAcquired = true;
        setGlobalAxesDragMode(true);
        setAxesDragging(true);
        return;
      }
      cleanup();
    };

    const onPointerLockError = () => {
      cleanup();
    };

    cleanupAxesDragRef.current = cleanup;
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp, { passive: false });
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);
    document.addEventListener("visibilitychange", onVisibilityChange);

    try {
      const lockResult = root.requestPointerLock();
      if (lockResult && typeof (lockResult as Promise<void>).catch === "function") {
        void (lockResult as Promise<void>).catch(() => {
          cleanup();
        });
      }
    } catch {
      cleanup();
    }
  };

  const toggleActorTransformMode = (mode: Exclude<ActorTransformMode, "none">) => {
    setActorTransformMode((current) => (current === mode ? "none" : mode));
  };

  useEffect(() => {
    if (props.suspended) {
      return;
    }
    if (!hostRef.current) {
      return;
    }
    const viewport: ViewportRuntime =
      backend === "webgl2"
        ? new WebGlViewport(kernel, hostRef.current, { antialias: antialiasing, qualityMode: "interactive" })
        : new WebGpuViewport(kernel, hostRef.current, { antialias: antialiasing, qualityMode: "interactive" });
    viewport.setActorTransformMode(actorTransformMode);
    viewport.setActorTransformSnappingEnabled(actorTransformSnappingEnabled);
    viewport.setFramePacing(framePacing);
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
      void viewport.stop();
      viewportRef.current = null;
    };
  }, [antialiasing, backend, kernel, props.suspended]);

  useEffect(() => {
    viewportRef.current?.setActorTransformMode(actorTransformMode);
  }, [actorTransformMode]);

  useEffect(() => {
    viewportRef.current?.setActorTransformSnappingEnabled(actorTransformSnappingEnabled);
  }, [actorTransformSnappingEnabled]);

  useEffect(() => {
    viewportRef.current?.setFramePacing(framePacing);
  }, [framePacing]);

  useEffect(() => {
    const requestId = props.screenshotRequestId ?? 0;
    if (requestId <= 0 || requestId === lastScreenshotRequestIdRef.current) {
      return;
    }
    lastScreenshotRequestIdRef.current = requestId;
    if (props.suspended) {
      kernel.store.getState().actions.setStatus("Viewport screenshot failed: viewport is suspended.");
      props.onScreenshotBusyChange?.(false);
      return;
    }
    if (screenshotInFlightRef.current) {
      return;
    }
    const viewportRuntime = viewportRef.current;
    if (!viewportRuntime) {
      kernel.store.getState().actions.setStatus("Viewport screenshot failed: viewport is unavailable.");
      props.onScreenshotBusyChange?.(false);
      return;
    }
    screenshotInFlightRef.current = true;
    const captureWidth = Math.max(0, viewportSize.width, Math.round(hostRef.current?.clientWidth ?? 0));
    const captureHeight = Math.max(0, viewportSize.height, Math.round(hostRef.current?.clientHeight ?? 0));
    let active = true;
    void viewportRuntime.captureViewportScreenshot({
      width: captureWidth,
      height: captureHeight
    })
      .then(async (result) => {
        if (!window.electronAPI?.writeClipboardImagePng) {
          throw new Error("Viewport screenshots are available in desktop mode only.");
        }
        await window.electronAPI.writeClipboardImagePng({
          pngBytes: result.pngBytes
        });
        if (!active) {
          return;
        }
        kernel.store.getState().actions.setStatus(formatViewportScreenshotStatus(result));
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown screenshot failure";
        kernel.store.getState().actions.setStatus(`Viewport screenshot failed: ${message}`);
      })
      .finally(() => {
        screenshotInFlightRef.current = false;
        props.onScreenshotBusyChange?.(false);
      });
    return () => {
      active = false;
    };
  }, [
    antialiasing,
    backend,
    kernel,
    props.onScreenshotBusyChange,
    props.screenshotRequestId,
    props.suspended,
    viewportSize.height,
    viewportSize.width
  ]);

  useEffect(() => {
    return () => {
      cleanupAxesDragRef.current?.();
      setGlobalAxesDragMode(false);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setActorTransformSnapShiftOverride(true);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
        return;
      }
      if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        setActorTransformMode((current) => (current === "translate" ? "none" : "translate"));
        return;
      }
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        setActorTransformMode((current) => (current === "rotate" ? "none" : "rotate"));
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        setActorTransformMode((current) => (current === "scale" ? "none" : "scale"));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setActorTransformSnapShiftOverride(false);
      }
    };
    const onBlur = () => {
      setActorTransformSnapShiftOverride(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.suspended || !viewportHoveredRef.current || isEditableTarget(event.target)) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const shortcut = normalizeViewportShortcut(event);
      if (!shortcut) {
        return;
      }
      if (event.repeat && (shortcut === "1" || shortcut === "3" || shortcut === "5" || shortcut === "7" || shortcut === "9")) {
        return;
      }

      const current = cameraRef.current;
      let next: CameraState | null = null;
      if (shortcut === "1" || shortcut === "3" || shortcut === "7") {
        next = applyDirectionalShortcut(current, rememberedPerspectiveCamera, shortcut);
      } else if (shortcut === "2" || shortcut === "4" || shortcut === "6" || shortcut === "8") {
        next = applyOrbitShortcut(current, shortcut);
      } else if (shortcut === "5") {
        next = toggleCameraProjectionMode(current, rememberedPerspectiveCamera);
      } else if (shortcut === "9") {
        next = flipCameraAroundTarget(current);
      }

      if (!next) {
        return;
      }
      event.preventDefault();
      requestCamera(next);
    };

    const onBlur = () => {
      viewportHoveredRef.current = false;
      setViewportHovered(false);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [kernel, props.suspended]);

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
    <div
      className={`viewport-panel${viewportHovered ? " is-hovered" : ""}`}
      onPointerEnter={() => {
        viewportHoveredRef.current = true;
        setViewportHovered(true);
      }}
      onPointerLeave={() => {
        viewportHoveredRef.current = false;
        setViewportHovered(false);
      }}
    >
      <div className="viewport-canvas-host" ref={hostRef} />
      {!props.suspended ? (
        <div className="viewport-transform-toolbar" role="toolbar" aria-label="Actor transform mode">
          <button
            type="button"
            className={`viewport-transform-button${actorTransformMode === "translate" ? " is-active" : ""}`}
            onClick={() => toggleActorTransformMode("translate")}
            title={`Translate selected actor (G)${actorTransformMode === "translate" ? " - click again to hide gizmo" : ""}`}
            aria-label="Translate selected actor (G)"
          >
            <FontAwesomeIcon icon={faUpDownLeftRight} />
          </button>
          <button
            type="button"
            className={`viewport-transform-button${actorTransformMode === "rotate" ? " is-active" : ""}`}
            onClick={() => toggleActorTransformMode("rotate")}
            title={`Rotate selected actor (R)${actorTransformMode === "rotate" ? " - click again to hide gizmo" : ""}`}
            aria-label="Rotate selected actor (R)"
          >
            <FontAwesomeIcon icon={faRotateRight} />
          </button>
          <button
            type="button"
            className={`viewport-transform-button${actorTransformMode === "scale" ? " is-active" : ""}`}
            onClick={() => toggleActorTransformMode("scale")}
            title={`Scale selected actor (S)${actorTransformMode === "scale" ? " - click again to hide gizmo" : ""}`}
            aria-label="Scale selected actor (S)"
          >
            <FontAwesomeIcon icon={faMaximize} />
          </button>
          <button
            type="button"
            className={`viewport-transform-button${actorTransformSnapToggled ? " is-active" : ""}`}
            onClick={() => setActorTransformSnapToggled((value) => !value)}
            title={`Transform snapping ${actorTransformSnapToggled ? "on" : "off"} (hold Shift to temporarily ${actorTransformSnapToggled ? "disable" : "enable"})`}
            aria-label={`Transform snapping ${actorTransformSnapToggled ? "on" : "off"}`}
          >
            <FontAwesomeIcon icon={faMagnet} />
          </button>
        </div>
      ) : null}
      {!props.suspended ? (
        <div className={`viewport-axes-widget${axesDragging ? " is-dragging" : ""}`}>
          <svg className="viewport-axes-stems" viewBox="0 0 116 116" aria-hidden>
            {axisHandles.map((handle) => (
              <line
                key={`stem-${handle.id}`}
                x1="58"
                y1="58"
                x2={String(58 + handle.left)}
                y2={String(58 + handle.top)}
                className={`viewport-axes-stem axis-${handle.axis}${handle.negative ? " is-negative" : ""}`}
              />
            ))}
          </svg>
          <div
            ref={axesHitAreaRef}
            className="viewport-axes-hit-area"
            onPointerDown={startAxesDrag}
            title="Drag to orbit around the current target"
          />
          {axisHandles.map((handle) => (
            <button
              key={handle.id}
              type="button"
              className={`viewport-axes-handle axis-${handle.axis}${handle.negative ? " is-negative" : ""}`}
              style={{
                left: `calc(50% + ${handle.left}px)`,
                top: `calc(50% + ${handle.top}px)`,
                zIndex: String(depthToZIndex(handle.depth))
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                requestCamera(
                  cameraStateForViewDirection(cameraRef.current, handle.view, "orthographic", rememberedPerspectiveCamera)
                );
              }}
              title={`Snap to ${handle.label} orthographic view`}
              aria-label={`Snap to ${handle.label} orthographic view`}
            >
              {handle.label}
            </button>
          ))}
          <button
            type="button"
            className={`viewport-axes-center${camera.mode === "perspective" ? " is-perspective" : ""}`}
            style={{ zIndex: String(depthToZIndex(0)) }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              requestCamera(toggleCameraProjectionMode(cameraRef.current, rememberedPerspectiveCamera));
            }}
            title={camera.mode === "perspective" ? "Switch to orthographic view (5)" : "Return to perspective view (5)"}
            aria-label={camera.mode === "perspective" ? "Switch to orthographic view" : "Return to perspective view"}
          >
            {camera.mode === "perspective" ? "P" : "O"}
          </button>
          <div className="viewport-axes-readout">
            {(() => {
              const forward = getCameraForward(camera);
              let bestDirection: CameraViewDirection = "isometric";
              let bestDot = -Infinity;
              for (const direction of ["front", "back", "left", "right", "top", "bottom"] as const) {
                const dot = forward.dot(getViewDirectionVector(direction));
                if (dot > bestDot) {
                  bestDot = dot;
                  bestDirection = direction;
                }
              }
              return bestDot >= 0.96 ? bestDirection.toUpperCase() : "FREE";
            })()}
          </div>
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

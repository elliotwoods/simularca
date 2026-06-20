import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCamera,
  faChartColumn,
  faCheck,
  faCirclePause,
  faCirclePlay,
  faForwardStep,
  faFilm,
  faGlobe,
  faKeyboard,
  faNoteSticky,
  faPalette,
  faPrint,
  faRotateLeft,
  faRotateRight,
  faRuler
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { TimeSpeedPreset } from "@/core/types";
import { formatFramePacingLabel } from "@/render/framePacing";
import type { ProfilingPublicState } from "@/render/profiling";
import { MaterialsModal } from "@/ui/components/MaterialsModal";
import { PublishModal } from "@/ui/components/PublishModal";
import { DigitScrubInput } from "@/ui/widgets";

const SPEEDS: TimeSpeedPreset[] = [0.125, 0.25, 0.5, 1, 2, 4];
const FPS_TARGET_PRESETS = [30, 60, 120];
const MAX_CUSTOM_TARGET_FPS = 240;
const TOOLBAR_LAYOUT_MODES = ["full", "compact", "wrapped", "scroll"] as const;

type ToolbarLayoutMode = (typeof TOOLBAR_LAYOUT_MODES)[number];

const TOOLBAR_SECTIONS: { key: keyof TopBarPanelVisibility; label: string }[] = [
  { key: "time", label: "Time" },
  { key: "tools", label: "Tools" },
  { key: "edit", label: "Edit" },
  { key: "render", label: "Render" },
  { key: "profile", label: "Profile" },
  { key: "materials", label: "Materials" },
  { key: "fps", label: "FPS" },
  { key: "keyboard", label: "Keyboard" }
];

function formatSpeed(speed: TimeSpeedPreset): string {
  if (speed >= 1) {
    return `${speed}x`;
  }
  return `1/${Math.round(1 / speed)}x`;
}

function formatTimecode(totalFrames: number, fps: number): string {
  const safeFps = Math.max(1, Math.floor(fps));
  const safeFrames = Math.max(0, Math.floor(totalFrames));
  const frame = safeFrames % safeFps;
  const totalSeconds = Math.floor(safeFrames / safeFps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(
    frame
  ).padStart(2, "0")}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Per-section toolbar visibility. When `undefined` (editor default) every
 * section is shown. When provided, each `false` flag hides that section. The
 * `render`, `profile`, and `publish` buttons are also force-hidden when
 * `state.mode === "web-ro"` regardless of these flags (they are editor-only
 * affordances).
 */
export interface TopBarPanelVisibility {
  time?: boolean;
  edit?: boolean;
  render?: boolean;
  profile?: boolean;
  keyboard?: boolean;
  materials?: boolean;
  fps?: boolean;
  tools?: boolean;
}

interface TopBarPanelProps {
  onToggleKeyboardMap: () => void;
  onOpenRender: () => void;
  onOpenPrint: () => void;
  onCaptureViewportScreenshot: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  canCaptureViewportScreenshot: boolean;
  viewportScreenshotBusy: boolean;
  onOpenProfiling: () => void;
  profilingState: ProfilingPublicState;
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
  /** Optional per-section visibility filter (viewer mode uses this). */
  visibility?: TopBarPanelVisibility;
}

export function TopBarPanel(props: TopBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [materialsModalOpen, setMaterialsModalOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [fpsMenuOpen, setFpsMenuOpen] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [toolbarMenuPosition, setToolbarMenuPosition] = useState({ top: 0, left: 0 });
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const [customTargetOpen, setCustomTargetOpen] = useState(false);
  const [customTargetDraft, setCustomTargetDraft] = useState("60");
  const [toolbarLayoutMode, setToolbarLayoutMode] = useState<ToolbarLayoutMode>("full");
  const fpsMenuRef = useRef<HTMLDivElement | null>(null);
  const fpsButtonRef = useRef<HTMLButtonElement | null>(null);
  const fpsPopoverRef = useRef<HTMLDivElement | null>(null);
  const customTargetInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarMeasurementFrameRef = useRef<number | null>(null);
  const toolbarLayoutModeRef = useRef<ToolbarLayoutMode>("full");
  const scheduleToolbarMeasurementRef = useRef<(() => void) | null>(null);
  const [fpsMenuPosition, setFpsMenuPosition] = useState({ top: 0, left: 0, minWidth: 210 });

  const isReadOnly = state.mode === "web-ro";
  // Viewer mode passes an explicit visibility prop (from publish config); the editor
  // falls back to the per-project persisted toolbar visibility toggled via right-click.
  const visibility = props.visibility ?? state.toolbarVisibility;
  const showSection = (key: keyof TopBarPanelVisibility, defaultVisible = true): boolean => {
    if (!visibility) return defaultVisible;
    const value = visibility[key];
    return value ?? false;
  };
  // Force-hide editor-only affordances when the viewer renders this toolbar.
  const showTime = showSection("time");
  const showEdit = showSection("edit") && !isReadOnly;
  const showRender = showSection("render") && !isReadOnly;
  const showProfile = showSection("profile") && !isReadOnly;
  const showKeyboard = showSection("keyboard");
  const showMaterials = showSection("materials");
  const showFps = showSection("fps");
  const showTools = showSection("tools") && !isReadOnly;
  const interactionTool = state.interactionTool;
  const toggleInteractionTool = (tool: "dimension" | "annotation"): void => {
    const next = interactionTool === tool ? "select" : tool;
    kernel.store.getState().actions.setInteractionTool(next);
    kernel.store.getState().actions.setStatus(
      next === "select"
        ? "Tool: Select"
        : next === "dimension"
          ? "Dimension tool: click two landmark points (Shift = direct, Esc = cancel)."
          : "Annotation tool: click a landmark point to place a note (Esc = cancel)."
    );
  };
  const fpsValue = Number.isFinite(state.stats.fps) ? state.stats.fps : 0;
  const frameMsValue = Number.isFinite(state.stats.frameMs) ? state.stats.frameMs : 0;
  const framePacing = state.scene.framePacing;
  const framePacingLabel = formatFramePacingLabel(framePacing);
  const simTimeSeconds = Number.isFinite(state.time.elapsedSimSeconds) ? state.time.elapsedSimSeconds : 0;
  const fixedStepMs = Number.isFinite(state.time.fixedStepSeconds) ? state.time.fixedStepSeconds * 1000 : 0;
  const fixedStepSeconds = Number.isFinite(state.time.fixedStepSeconds) ? state.time.fixedStepSeconds : 0;
  const timecodeFps = Math.max(1, Math.round(1 / Math.max(1e-6, fixedStepSeconds)));
  const simFrame = Math.max(0, Math.round(simTimeSeconds * timecodeFps));
  const simTimecode = formatTimecode(simFrame, timecodeFps);
  const tcFrames = simFrame % timecodeFps;
  const tcTotalSeconds = Math.floor(simFrame / timecodeFps);
  const tcSeconds = tcTotalSeconds % 60;
  const tcTotalMinutes = Math.floor(tcTotalSeconds / 60);
  const tcMinutes = tcTotalMinutes % 60;
  const tcHours = Math.floor(tcTotalMinutes / 60);
  const profileCaptureProgress =
    props.profilingState.requestedFrameCount > 0
      ? Math.max(0, Math.min(1, props.profilingState.capturedFrameCount / props.profilingState.requestedFrameCount))
      : 0;
  const profileProgressLabel =
    props.profilingState.phase === "capturing"
      ? props.profilingState.pendingGpuFrames > 0
        ? `GPU ${props.profilingState.capturedFrameCount}/${props.profilingState.requestedFrameCount}`
        : `${props.profilingState.capturedFrameCount}/${props.profilingState.requestedFrameCount}`
      : props.profilingState.result
        ? `Ready (${props.profilingState.result.frames.length}f)`
        : "Idle";
  const profileProgressTitle =
    props.profilingState.phase === "capturing"
      ? props.profilingState.pendingGpuFrames > 0
        ? `Profiling ${props.profilingState.capturedFrameCount}/${props.profilingState.requestedFrameCount} frames. Waiting for GPU timestamps.`
        : `Profiling ${props.profilingState.capturedFrameCount}/${props.profilingState.requestedFrameCount} frames.`
      : props.profilingState.result
        ? `Latest profile captured ${props.profilingState.result.frames.length} frames.`
        : "No active profile capture.";

  const setTimecodeParts = (next: { hours?: number; minutes?: number; seconds?: number; frames?: number }) => {
    const hours = clampInteger(next.hours ?? tcHours, 0, 9999);
    const minutes = clampInteger(next.minutes ?? tcMinutes, 0, 59);
    const seconds = clampInteger(next.seconds ?? tcSeconds, 0, 59);
    const frames = clampInteger(next.frames ?? tcFrames, 0, Math.max(0, timecodeFps - 1));
    const composedFrames = ((((hours * 60 + minutes) * 60 + seconds) * timecodeFps) + frames);
    kernel.store.getState().actions.setElapsedSimSeconds(composedFrames / timecodeFps);
  };

  useEffect(() => {
    setFpsHistory((previous) => {
      const next = [...previous, fpsValue];
      if (next.length > 64) {
        next.splice(0, next.length - 64);
      }
      return next;
    });
  }, [fpsValue]);

  const fpsGraphMax = useMemo(() => {
    const targetMax = framePacing.mode === "fixed" ? framePacing.targetFps : 0;
    return Math.max(30, targetMax, ...fpsHistory);
  }, [fpsHistory, framePacing.mode, framePacing.targetFps]);

  const fpsGraphPath = useMemo(() => {
    if (fpsHistory.length === 0) {
      return "";
    }
    const width = 92;
    const height = 18;
    const points = fpsHistory.map((value, index) => {
      const x = fpsHistory.length > 1 ? (index / (fpsHistory.length - 1)) * width : width;
      const normalized = Math.max(0, Math.min(1, value / fpsGraphMax));
      const y = height - normalized * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(" ");
  }, [fpsGraphMax, fpsHistory]);

  const fpsTargetY = useMemo(() => {
    if (framePacing.mode !== "fixed") {
      return null;
    }
    const height = 18;
    const normalized = Math.max(0, Math.min(1, framePacing.targetFps / fpsGraphMax));
    return height - normalized * height;
  }, [fpsGraphMax, framePacing.mode, framePacing.targetFps]);

  useEffect(() => {
    setCustomTargetDraft(String(Math.max(1, Math.round(framePacing.targetFps))));
  }, [framePacing.targetFps]);

  useEffect(() => {
    if (!fpsMenuOpen) {
      setCustomTargetOpen(false);
      return;
    }
    const updatePosition = () => {
      const rect = fpsButtonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setFpsMenuPosition({
        top: Math.round(rect.bottom + 8),
        left: Math.round(rect.right - Math.max(rect.width, 210)),
        minWidth: Math.max(Math.round(rect.width), 210)
      });
    };
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !fpsMenuRef.current?.contains(target) &&
        !fpsPopoverRef.current?.contains(target)
      ) {
        setFpsMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFpsMenuOpen(false);
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fpsMenuOpen]);

  const handleToolbarContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isReadOnly) {
      return;
    }
    event.preventDefault();
    const estWidth = 200;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - estWidth - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - 8));
    setToolbarMenuPosition({ top, left });
    setToolbarMenuOpen(true);
  };

  useEffect(() => {
    if (!toolbarMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !toolbarMenuRef.current?.contains(target)) {
        setToolbarMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolbarMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toolbarMenuOpen]);

  useEffect(() => {
    if (fpsMenuOpen && customTargetOpen) {
      customTargetInputRef.current?.focus();
      customTargetInputRef.current?.select();
    }
  }, [customTargetOpen, fpsMenuOpen]);

  const applyFramePacing = (mode: "vsync" | "fixed", targetFps: number) => {
    kernel.store.getState().actions.setSceneRenderSettings({
      framePacing: {
        mode,
        targetFps
      }
    });
    setFpsMenuOpen(false);
  };

  const submitCustomTarget = () => {
    const parsed = Number(customTargetDraft);
    if (!Number.isFinite(parsed)) {
      kernel.store.getState().actions.setStatus("Target framerate must be a number.");
      return;
    }
    applyFramePacing("fixed", Math.max(1, Math.min(MAX_CUSTOM_TARGET_FPS, Math.round(parsed))));
  };

  useEffect(() => {
    toolbarLayoutModeRef.current = toolbarLayoutMode;
  }, [toolbarLayoutMode]);

  useEffect(() => {
    const toolbarEl = toolbarRef.current;
    if (!toolbarEl) {
      return;
    }

    const applyToolbarLayoutMode = (mode: ToolbarLayoutMode) => {
      toolbarEl.classList.toggle("is-compact", mode === "compact" || mode === "wrapped" || mode === "scroll");
      toolbarEl.classList.toggle("is-wrapped", mode === "wrapped");
      toolbarEl.classList.toggle("is-scroll", mode === "scroll");
      toolbarEl.dataset.layoutMode = mode;
    };

    const measureToolbarLayout = () => {
      let nextMode: ToolbarLayoutMode = "scroll";
      for (const candidate of TOOLBAR_LAYOUT_MODES) {
        applyToolbarLayoutMode(candidate);
        if (toolbarEl.scrollWidth <= toolbarEl.clientWidth + 1) {
          nextMode = candidate;
          break;
        }
      }
      applyToolbarLayoutMode(nextMode);
      if (nextMode !== toolbarLayoutModeRef.current) {
        toolbarLayoutModeRef.current = nextMode;
        setToolbarLayoutMode(nextMode);
      }
    };

    const scheduleToolbarMeasurement = () => {
      if (toolbarMeasurementFrameRef.current !== null) {
        return;
      }
      toolbarMeasurementFrameRef.current = window.requestAnimationFrame(() => {
        toolbarMeasurementFrameRef.current = null;
        measureToolbarLayout();
      });
    };
    scheduleToolbarMeasurementRef.current = scheduleToolbarMeasurement;

    const observer = new ResizeObserver(() => {
      scheduleToolbarMeasurement();
    });
    observer.observe(toolbarEl);
    window.addEventListener("resize", scheduleToolbarMeasurement);
    scheduleToolbarMeasurement();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleToolbarMeasurement);
      scheduleToolbarMeasurementRef.current = null;
      if (toolbarMeasurementFrameRef.current !== null) {
        window.cancelAnimationFrame(toolbarMeasurementFrameRef.current);
        toolbarMeasurementFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    scheduleToolbarMeasurementRef.current?.();
  }, [toolbarLayoutMode]);

  return (
    <div
      ref={toolbarRef}
      className={`top-toolbar${toolbarLayoutMode === "compact" || toolbarLayoutMode === "wrapped" || toolbarLayoutMode === "scroll" ? " is-compact" : ""}${toolbarLayoutMode === "wrapped" ? " is-wrapped" : ""}${toolbarLayoutMode === "scroll" ? " is-scroll" : ""}`}
      data-layout-mode={toolbarLayoutMode}
      onContextMenu={handleToolbarContextMenu}
    >
      {showTime ? (
      <div className="toolbar-group">
        <label className="toolbar-group-label" title="Simulation controls">Time</label>
        <button
          type="button"
          title="Play / Pause"
          onClick={() => kernel.store.getState().actions.setTimeRunning(!state.time.running)}
        >
          <FontAwesomeIcon icon={state.time.running ? faCirclePause : faCirclePlay} />
        </button>
        <button type="button" title="Step one frame" onClick={() => kernel.store.getState().actions.stepTime(1)}>
          <FontAwesomeIcon icon={faForwardStep} />
        </button>
        <select
          value={state.time.speed}
          onChange={(event) => kernel.store.getState().actions.setTimeSpeed(Number(event.target.value) as TimeSpeedPreset)}
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {formatSpeed(speed)}
            </option>
          ))}
        </select>
        <div className="toolbar-time-readout" title="Simulation time diagnostics">
          <div className="toolbar-timecode-editor">
            <DigitScrubInput
              className="widget-digit-input-rangeless toolbar-timecode-segment"
              value={tcHours}
              precision={0}
              onChange={(nextHours) => setTimecodeParts({ hours: nextHours })}
            />
            <span>:</span>
            <DigitScrubInput
              className="widget-digit-input-rangeless toolbar-timecode-segment"
              value={tcMinutes}
              precision={0}
              onChange={(nextMinutes) => setTimecodeParts({ minutes: nextMinutes })}
            />
            <span>:</span>
            <DigitScrubInput
              className="widget-digit-input-rangeless toolbar-timecode-segment"
              value={tcSeconds}
              precision={0}
              onChange={(nextSeconds) => setTimecodeParts({ seconds: nextSeconds })}
            />
            <span>:</span>
            <DigitScrubInput
              className="widget-digit-input-rangeless toolbar-timecode-segment"
              value={tcFrames}
              precision={0}
              onChange={(nextFrames) => setTimecodeParts({ frames: nextFrames })}
            />
          </div>
          <strong>{simTimecode}</strong>
          <span>{state.time.running ? "Running" : "Paused"}</span>
          <span>{simTimeSeconds.toFixed(2)}s</span>
          <span>{timecodeFps}fps</span>
          <span>{fixedStepMs.toFixed(2)}ms step</span>
        </div>
      </div>
      ) : null}

      {showTools ? (
        <div className="toolbar-group">
          <label className="toolbar-group-label" title="Measure & annotate">Tools</label>
          <button
            type="button"
            title="Dimension tool — measure distance between two landmark points"
            aria-pressed={interactionTool === "dimension"}
            className={interactionTool === "dimension" ? "toolbar-tool-active" : undefined}
            onClick={() => toggleInteractionTool("dimension")}
          >
            <FontAwesomeIcon icon={faRuler} />
          </button>
          <button
            type="button"
            title="Annotation tool — attach a text note to a landmark point"
            aria-pressed={interactionTool === "annotation"}
            className={interactionTool === "annotation" ? "toolbar-tool-active" : undefined}
            onClick={() => toggleInteractionTool("annotation")}
          >
            <FontAwesomeIcon icon={faNoteSticky} />
          </button>
        </div>
      ) : null}

      {showEdit ? (
        <div className="toolbar-group">
          <label className="toolbar-group-label" title="History">Edit</label>
          <button type="button" title="Undo" onClick={() => kernel.store.getState().actions.undo()}>
            <FontAwesomeIcon icon={faRotateLeft} />
          </button>
          <button type="button" title="Redo" onClick={() => kernel.store.getState().actions.redo()}>
            <FontAwesomeIcon icon={faRotateRight} />
          </button>
        </div>
      ) : null}

      {showRender ? (
      <div className="toolbar-group">
        <label className="toolbar-group-label" title="Render">Render</label>
        <button type="button" title="Render video" onClick={props.onOpenRender}>
          <FontAwesomeIcon icon={faFilm} />
        </button>
        <button type="button" title="Print / export page (PDF, PNG)" onClick={props.onOpenPrint}>
          <FontAwesomeIcon icon={faPrint} />
        </button>
        <button
          type="button"
          title={
            !props.canCaptureViewportScreenshot
              ? "Copy viewport screenshot to clipboard (desktop only)"
              : props.viewportScreenshotBusy
                ? "Viewport screenshot in progress"
                : "Copy viewport screenshot to clipboard\nShift-click for clean render (helpers off)"
          }
          aria-label="Copy viewport screenshot to clipboard"
          onClick={(event) => props.onCaptureViewportScreenshot(event)}
          disabled={!props.canCaptureViewportScreenshot || props.viewportScreenshotBusy}
        >
          <FontAwesomeIcon icon={faCamera} />
        </button>
        <button
          type="button"
          title={
            !state.activeProject
              ? "Open a project first"
              : isReadOnly
                ? "Read-only mode"
                : "Publish to web…"
          }
          aria-label="Publish to web"
          onClick={() => setPublishModalOpen(true)}
          disabled={!state.activeProject || isReadOnly}
        >
          <FontAwesomeIcon icon={faGlobe} />
        </button>
      </div>
      ) : null}

      {showProfile ? (
      <div className="toolbar-group toolbar-profile-group">
        <label className="toolbar-group-label" title="Performance Profile">Profile</label>
        <button
          type="button"
          title={
            props.profilingState.phase === "capturing"
              ? "Performance profile capture in progress"
              : "Open performance profile capture"
          }
          aria-label="Open performance profile"
          onClick={props.profilingState.phase === "capturing" ? undefined : props.onOpenProfiling}
          disabled={props.profilingState.phase === "capturing"}
        >
          <FontAwesomeIcon icon={faChartColumn} />
        </button>
        <div className={`toolbar-profile-progress${props.profilingState.phase === "capturing" ? " is-active" : ""}`} title={profileProgressTitle}>
          <div className="toolbar-profile-progress-track">
            <div
              className="toolbar-profile-progress-fill"
              style={{
                width: `${profileCaptureProgress * 100}%`
              }}
            />
          </div>
          <span className="toolbar-profile-progress-label">{profileProgressLabel}</span>
        </div>
      </div>
      ) : null}

      {showKeyboard ? (
        <div className="toolbar-group">
          <button type="button" title="Keyboard map" onClick={props.onToggleKeyboardMap}>
            <FontAwesomeIcon icon={faKeyboard} />
          </button>
        </div>
      ) : null}

      {showMaterials ? (
        <div className="toolbar-group">
          <label className="toolbar-group-label" title="Materials">Materials</label>
          <button
            type="button"
            title="Open material library"
            onClick={() => {
              setMaterialsModalOpen(true);
            }}
          >
            <FontAwesomeIcon icon={faPalette} />
          </button>
        </div>
      ) : null}

      {showFps ? (
      <div className="toolbar-group toolbar-fps-group" title="Viewport frame rate">
        <label className="toolbar-group-label">FPS</label>
        <div className="toolbar-fps-shell" ref={fpsMenuRef}>
          <button
            ref={fpsButtonRef}
            type="button"
            className={`toolbar-fps-widget${fpsMenuOpen ? " is-open" : ""}`}
            onClick={() => {
              if (isReadOnly) {
                return;
              }
              setFpsMenuOpen((value) => !value);
            }}
            disabled={isReadOnly}
            aria-haspopup="dialog"
            aria-expanded={fpsMenuOpen}
            title={isReadOnly ? `Viewport frame rate (${framePacingLabel})` : `Viewport frame rate target: ${framePacingLabel}`}
          >
            <div className="toolbar-fps-values">
              <strong>{fpsValue.toFixed(1)}</strong>
              <span>{frameMsValue.toFixed(2)} ms</span>
              <span>target {framePacingLabel}</span>
            </div>
            <svg className="toolbar-fps-graph" viewBox="0 0 92 18" preserveAspectRatio="none" aria-hidden>
              {fpsTargetY !== null ? <line x1="0" y1={fpsTargetY} x2="92" y2={fpsTargetY} className="toolbar-fps-target-line" /> : null}
              {fpsGraphPath ? <polyline points={fpsGraphPath} /> : null}
            </svg>
          </button>
          {fpsMenuOpen
            ? createPortal(
                <div
                  ref={fpsPopoverRef}
                  className="toolbar-fps-popover"
                  style={{
                    top: `${fpsMenuPosition.top}px`,
                    left: `${fpsMenuPosition.left}px`,
                    minWidth: `${fpsMenuPosition.minWidth}px`
                  }}
                  role="dialog"
                  aria-label="Target framerate"
                >
              <div className="toolbar-fps-popover-title">Target Framerate</div>
              <button
                type="button"
                className={`toolbar-fps-option${framePacing.mode === "vsync" ? " is-active" : ""}`}
                onClick={() => applyFramePacing("vsync", framePacing.targetFps)}
              >
                <span>VSync</span>
                <small>Use the display refresh ceiling</small>
              </button>
              {FPS_TARGET_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`toolbar-fps-option${framePacing.mode === "fixed" && framePacing.targetFps === preset ? " is-active" : ""}`}
                  onClick={() => applyFramePacing("fixed", preset)}
                >
                  <span>{preset} FPS</span>
                  <small>Fixed frame cap</small>
                </button>
              ))}
              {customTargetOpen ? (
                <form
                  className="toolbar-fps-custom"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitCustomTarget();
                  }}
                >
                  <input
                    ref={customTargetInputRef}
                    type="number"
                    min={1}
                    max={MAX_CUSTOM_TARGET_FPS}
                    step={1}
                    value={customTargetDraft}
                    onChange={(event) => setCustomTargetDraft(event.target.value)}
                    onBlur={() => {
                      if (!customTargetDraft.trim()) {
                        setCustomTargetOpen(false);
                      }
                    }}
                  />
                  <button type="submit">Set</button>
                </form>
              ) : (
                <button
                  type="button"
                  className={`toolbar-fps-option${
                    framePacing.mode === "fixed" && !FPS_TARGET_PRESETS.includes(framePacing.targetFps) ? " is-active" : ""
                  }`}
                  onClick={() => setCustomTargetOpen(true)}
                >
                  <span>Custom...</span>
                  <small>{framePacing.mode === "fixed" ? `${framePacing.targetFps} FPS` : "Enter any target up to 240 FPS"}</small>
                </button>
              )}
                </div>,
                document.body
              )
            : null}
        </div>
      </div>
      ) : null}
      <MaterialsModal open={materialsModalOpen} onClose={() => setMaterialsModalOpen(false)} />
      <PublishModal open={publishModalOpen} onClose={() => setPublishModalOpen(false)} />
      {toolbarMenuOpen
        ? createPortal(
            <div
              ref={toolbarMenuRef}
              className="toolbar-section-menu"
              style={{ top: `${toolbarMenuPosition.top}px`, left: `${toolbarMenuPosition.left}px` }}
              role="menu"
              aria-label="Toolbar sections"
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="toolbar-fps-popover-title">Toolbars</div>
              {TOOLBAR_SECTIONS.map(({ key, label }) => {
                const checked = visibility?.[key] ?? true;
                return (
                  <button
                    key={key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className={`toolbar-section-option${checked ? " is-active" : ""}`}
                    onClick={() => kernel.store.getState().actions.setToolbarSectionVisible(key, !checked)}
                  >
                    <FontAwesomeIcon
                      icon={faCheck}
                      className="toolbar-section-check"
                      style={{ visibility: checked ? "visible" : "hidden" }}
                    />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

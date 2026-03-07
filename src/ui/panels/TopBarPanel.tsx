import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCube,
  faCamera,
  faCirclePause,
  faCirclePlay,
  faForwardStep,
  faFilm,
  faKeyboard,
  faPalette,
  faRotateLeft,
  faRotateRight
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { CameraPreset, TimeSpeedPreset } from "@/core/types";
import { discoverAndLoadLocalPlugins, formatPluginDiscoverySummary } from "@/features/plugins/discovery";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { PluginsModal } from "@/ui/components/PluginsModal";
import { MaterialsModal } from "@/ui/components/MaterialsModal";
import { DigitScrubInput } from "@/ui/widgets";

const SPEEDS: TimeSpeedPreset[] = [0.125, 0.25, 0.5, 1, 2, 4];
const CAMERA_PRESETS: CameraPreset[] = ["perspective", "isometric", "top", "left", "front", "back"];

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

interface TopBarPanelProps {
  onToggleKeyboardMap: () => void;
  onOpenRender: () => void;
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
}

export function TopBarPanel(props: TopBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [pluginsModalOpen, setPluginsModalOpen] = useState(false);
  const [materialsModalOpen, setMaterialsModalOpen] = useState(false);
  const [pluginsRefreshLoading, setPluginsRefreshLoading] = useState(false);
  const [pluginsRefreshSummary, setPluginsRefreshSummary] = useState<string | null>(null);
  const [pluginsRevision, setPluginsRevision] = useState(0);

  const isReadOnly = state.mode === "web-ro";
  const fpsValue = Number.isFinite(state.stats.fps) ? state.stats.fps : 0;
  const frameMsValue = Number.isFinite(state.stats.frameMs) ? state.stats.frameMs : 0;
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

  const fpsGraphPath = useMemo(() => {
    if (fpsHistory.length === 0) {
      return "";
    }
    const width = 92;
    const height = 18;
    const maxFps = Math.max(30, ...fpsHistory);
    const points = fpsHistory.map((value, index) => {
      const x = fpsHistory.length > 1 ? (index / (fpsHistory.length - 1)) * width : width;
      const normalized = Math.max(0, Math.min(1, value / maxFps));
      const y = height - normalized * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(" ");
  }, [fpsHistory]);
  const plugins = useMemo(() => {
    void pluginsRevision;
    return kernel.pluginApi.listPlugins();
  }, [kernel, pluginsRevision]);

  const refreshPlugins = () => {
    if (!window.electronAPI) {
      setPluginsRefreshSummary("Plugin discovery is available in desktop mode only.");
      setPluginsRevision((value) => value + 1);
      return;
    }
    setPluginsRefreshLoading(true);
    void discoverAndLoadLocalPlugins(kernel)
      .then((report) => {
        const summary = formatPluginDiscoverySummary(report);
        setPluginsRefreshSummary(summary);
        kernel.store.getState().actions.setStatus(`Plugins refreshed. ${summary}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown plugin refresh error";
        setPluginsRefreshSummary(`Refresh failed: ${message}`);
        kernel.store.getState().actions.setStatus(`Plugin refresh failed: ${message}`);
      })
      .finally(() => {
        setPluginsRefreshLoading(false);
        setPluginsRevision((value) => value + 1);
      });
  };

  return (
    <div className="top-toolbar">
      <div className="toolbar-group">
        <label title="Camera presets">Camera</label>
        <button
          type="button"
          title="Save camera bookmark"
          onClick={() => {
            void props
              .requestTextInput({
                title: "Save Camera Bookmark",
                label: "Bookmark name",
                initialValue: `Camera ${state.cameraBookmarks.length + 1}`,
                confirmLabel: "Save"
              })
              .then((name) => {
                if (name) {
                  kernel.store.getState().actions.saveCameraBookmark(name);
                }
              });
          }}
        >
          <FontAwesomeIcon icon={faCamera} />
        </button>
        <select
          onChange={(event) => {
            kernel.store.getState().actions.applyCameraPreset(event.target.value as CameraPreset);
          }}
          defaultValue="perspective"
        >
          {CAMERA_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
        <select
          value=""
          onChange={(event) => {
            if (!event.target.value) {
              return;
            }
            kernel.store.getState().actions.loadCameraBookmark(event.target.value);
          }}
        >
          <option value="">Bookmarks...</option>
          {state.cameraBookmarks.map((bookmark) => (
            <option key={bookmark.id} value={bookmark.id}>
              {bookmark.name}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">
        <label title="Simulation controls">Time</label>
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

      <div className="toolbar-group">
        <label title="History">Edit</label>
        <button type="button" title="Undo" onClick={() => kernel.store.getState().actions.undo()}>
          <FontAwesomeIcon icon={faRotateLeft} />
        </button>
        <button type="button" title="Redo" onClick={() => kernel.store.getState().actions.redo()}>
          <FontAwesomeIcon icon={faRotateRight} />
        </button>
      </div>

      <div className="toolbar-group">
        <label title="Create Actor Browser">Create</label>
        <AddActorMenu disabled={isReadOnly} registerGlobalShortcut />
      </div>

      <div className="toolbar-group">
        <label title="Render">Render</label>
        <button type="button" title="Render video" onClick={props.onOpenRender}>
          <FontAwesomeIcon icon={faFilm} />
        </button>
      </div>

      <div className="toolbar-group">
        <button type="button" title="Keyboard map" onClick={props.onToggleKeyboardMap}>
          <FontAwesomeIcon icon={faKeyboard} />
        </button>
      </div>

      <div className="toolbar-group">
        <label title="Materials">Materials</label>
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

      <div className="toolbar-group">
        <label title="Plugins">Plugins</label>
        <button
          type="button"
          title="Open plugins dialog"
          onClick={() => {
            setPluginsModalOpen(true);
          }}
        >
          <FontAwesomeIcon icon={faCube} />
        </button>
      </div>

      <div className="toolbar-group toolbar-fps-group" title="Viewport frame rate">
        <label>FPS</label>
        <div className="toolbar-fps-widget">
          <div className="toolbar-fps-values">
            <strong>{fpsValue.toFixed(1)}</strong>
            <span>{frameMsValue.toFixed(2)} ms</span>
          </div>
          <svg className="toolbar-fps-graph" viewBox="0 0 92 18" preserveAspectRatio="none" aria-hidden>
            {fpsGraphPath ? <polyline points={fpsGraphPath} /> : null}
          </svg>
        </div>
      </div>
      <MaterialsModal open={materialsModalOpen} onClose={() => setMaterialsModalOpen(false)} />
      <PluginsModal
        open={pluginsModalOpen}
        plugins={plugins}
        loading={pluginsRefreshLoading}
        lastRefreshSummary={pluginsRefreshSummary}
        onRefresh={refreshPlugins}
        onClose={() => setPluginsModalOpen(false)}
      />
    </div>
  );
}

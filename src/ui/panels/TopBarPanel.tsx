import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCube,
  faCamera,
  faCirclePause,
  faCirclePlay,
  faForwardStep,
  faKeyboard,
  faRotateLeft,
  faRotateRight
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { CameraPreset, TimeSpeedPreset } from "@/core/types";
import { discoverAndLoadLocalPlugins, formatPluginDiscoverySummary } from "@/features/plugins/discovery";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { PluginsModal } from "@/ui/components/PluginsModal";

const SPEEDS: TimeSpeedPreset[] = [0.125, 0.25, 0.5, 1, 2, 4];
const CAMERA_PRESETS: CameraPreset[] = ["perspective", "isometric", "top", "left", "front", "back"];

function formatSpeed(speed: TimeSpeedPreset): string {
  if (speed >= 1) {
    return `${speed}x`;
  }
  return `1/${Math.round(1 / speed)}x`;
}

interface TopBarPanelProps {
  onToggleKeyboardMap: () => void;
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
  const [pluginsRefreshLoading, setPluginsRefreshLoading] = useState(false);
  const [pluginsRefreshSummary, setPluginsRefreshSummary] = useState<string | null>(null);
  const [pluginsRevision, setPluginsRevision] = useState(0);

  const isReadOnly = state.mode === "web-ro";
  const fpsValue = Number.isFinite(state.stats.fps) ? state.stats.fps : 0;
  const frameMsValue = Number.isFinite(state.stats.frameMs) ? state.stats.frameMs : 0;

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
  }, [kernel, pluginsRevision, state.statusMessage]);

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
        <label title="Add actor">Add</label>
        <AddActorMenu disabled={isReadOnly} />
      </div>

      <div className="toolbar-group">
        <button type="button" title="Keyboard map" onClick={props.onToggleKeyboardMap}>
          <FontAwesomeIcon icon={faKeyboard} />
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

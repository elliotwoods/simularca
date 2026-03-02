import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCube,
  faBookmark,
  faCamera,
  faCirclePause,
  faCirclePlay,
  faFloppyDisk,
  faForwardStep,
  faKeyboard,
  faRotateLeft,
  faRotateRight
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { CameraPreset, TimeSpeedPreset } from "@/core/types";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { WindowControls } from "@/ui/components/WindowControls";

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
}

export function TopBarPanel(props: TopBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const sessionOptions = useMemo(() => {
    if (availableSessions.includes(state.activeSessionName)) {
      return availableSessions;
    }
    return [state.activeSessionName, ...availableSessions];
  }, [availableSessions, state.activeSessionName]);

  useEffect(() => {
    void kernel.sessionService.listSessions().then((sessions) => {
      setAvailableSessions(sessions);
    });
  }, [kernel]);

  const isReadOnly = state.mode === "web-ro";

  const sessionControls = useMemo(
    () => (
      <div className="toolbar-group">
        <label title="Current session">Session</label>
        <select
          value={state.activeSessionName}
          onChange={(event) => {
            void kernel.sessionService.loadSession(event.target.value);
          }}
        >
          {sessionOptions.map((sessionName) => (
            <option key={sessionName} value={sessionName}>
              {sessionName}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isReadOnly}
          title="Save"
          onClick={() => {
            void kernel.sessionService.saveSession();
          }}
        >
          <FontAwesomeIcon icon={faFloppyDisk} />
        </button>
        <button
          type="button"
          disabled={isReadOnly}
          title="Save As"
          onClick={() => {
            const nextName = window.prompt("Save as session name", state.activeSessionName);
            if (!nextName) {
              return;
            }
            void kernel.sessionService.saveAs(nextName).then(() => {
              setAvailableSessions((prev) => (prev.includes(nextName) ? prev : [...prev, nextName]));
            });
          }}
        >
          <FontAwesomeIcon icon={faBookmark} />
        </button>
      </div>
    ),
    [isReadOnly, kernel, sessionOptions, state.activeSessionName]
  );

  return (
    <div className="top-toolbar">
      <div className="app-title">Kinetic Sim</div>
      {sessionControls}

      <div className="toolbar-group">
        <label title="Camera presets">Camera</label>
        <button
          type="button"
          title="Save camera bookmark"
          onClick={() => {
            const name = window.prompt("Bookmark name", `Camera ${state.cameraBookmarks.length + 1}`);
            if (name) {
              kernel.store.getState().actions.saveCameraBookmark(name);
            }
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
        <AddActorMenu disabled={isReadOnly} label="Add..." />
      </div>

      <div className="toolbar-group">
        <button type="button" title="Keyboard map" onClick={props.onToggleKeyboardMap}>
          <FontAwesomeIcon icon={faKeyboard} />
        </button>
      </div>

      <div className="toolbar-group">
        <label title="Plugins">Plugin</label>
        <button
          type="button"
          title="Load plugin from module path"
          onClick={() => {
            const modulePath = window.prompt(
              "Plugin module path",
              "file:///absolute/path/to/plugin/dist/index.js"
            );
            if (!modulePath) {
              return;
            }
            void loadPluginFromModule(kernel, modulePath)
              .then((result) => {
                kernel.store
                  .getState()
                  .actions.setStatus(`Plugin loaded: ${result.manifest.name} (${result.manifest.version})`);
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : "Unknown plugin loader error";
                kernel.store.getState().actions.setStatus(`Plugin load failed: ${message}`);
              });
          }}
        >
          <FontAwesomeIcon icon={faCube} />
        </button>
      </div>

      <div className="toolbar-spacer" />
      <WindowControls />
    </div>
  );
}

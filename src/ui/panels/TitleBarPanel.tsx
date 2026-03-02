import { useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBookmark, faFloppyDisk, faPenToSquare, faPlus, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { WindowControls } from "@/ui/components/WindowControls";
import appIconUrl from "../../../icon.png";
import packageJson from "../../../package.json";

const APP_NAME = "Simularca";
const APP_VERSION = packageJson.version;

interface TitleBarPanelProps {
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
}

function nextSessionName(existingNames: string[]): string {
  const set = new Set(existingNames);
  if (!set.has("untitled")) {
    return "untitled";
  }
  let index = 2;
  while (set.has(`untitled-${String(index)}`)) {
    index += 1;
  }
  return `untitled-${String(index)}`;
}

export function TitleBarPanel(props: TitleBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [isSessionMenuOpen, setSessionMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isReadOnly = state.mode === "web-ro";

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
  }, [kernel, state.activeSessionName]);

  useEffect(() => {
    if (!isSessionMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setSessionMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isSessionMenuOpen]);

  return (
    <div className="titlebar">
      <div className="titlebar-left titlebar-interactive">
        <div className="titlebar-app-icon" aria-hidden="true">
          <img src={appIconUrl} alt="" />
        </div>
        <div className="titlebar-brand">
          <strong>{APP_NAME}</strong>
          <span>v{APP_VERSION}</span>
        </div>
      </div>

      <div className="titlebar-center titlebar-interactive">
        <div className="titlebar-session" ref={menuRef}>
          <button
            type="button"
            className="titlebar-session-trigger"
            title="Switch session"
            onClick={() => setSessionMenuOpen((value) => !value)}
          >
            Session: <strong>{state.activeSessionName}</strong>
            {state.dirty ? <em>*</em> : null}
          </button>
          {isSessionMenuOpen ? (
            <div className="titlebar-session-popover">
              <label>Active Session</label>
              <select
                value={state.activeSessionName}
                onChange={(event) => {
                  setSessionMenuOpen(false);
                  void kernel.sessionService.loadSession(event.target.value);
                }}
              >
                {sessionOptions.map((sessionName) => (
                  <option key={sessionName} value={sessionName}>
                    {sessionName}
                  </option>
                ))}
              </select>
              <div className="titlebar-session-actions">
                <button
                  type="button"
                  title="Reload from last save"
                  onClick={() => {
                    if (state.dirty) {
                      const confirmed = window.confirm("Discard unsaved changes and reload this session from disk?");
                      if (!confirmed) {
                        return;
                      }
                    }
                    setSessionMenuOpen(false);
                    void kernel.sessionService.loadSession(state.activeSessionName);
                  }}
                >
                  <FontAwesomeIcon icon={faRotateRight} />
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  title="Rename session"
                  onClick={() => {
                    void props
                      .requestTextInput({
                        title: "Rename Session",
                        label: "Session name",
                        initialValue: state.activeSessionName,
                        confirmLabel: "Rename"
                      })
                      .then((nextName) => {
                        if (!nextName) {
                          return;
                        }
                        if (nextName === state.activeSessionName) {
                          setSessionMenuOpen(false);
                          return;
                        }
                        setSessionMenuOpen(false);
                        void kernel.sessionService.renameSession(state.activeSessionName, nextName).then(() => {
                          setAvailableSessions((prev) =>
                            prev
                              .filter((entry) => entry !== state.activeSessionName)
                              .concat(nextName)
                              .sort((a, b) => a.localeCompare(b))
                          );
                        });
                      });
                  }}
                >
                  <FontAwesomeIcon icon={faPenToSquare} />
                </button>
                <button
                  type="button"
                  disabled={isReadOnly}
                  title="New session"
                  onClick={() => {
                    void props
                      .requestTextInput({
                        title: "Create New Session",
                        label: "Session name",
                        initialValue: nextSessionName(sessionOptions),
                        confirmLabel: "Create"
                      })
                      .then((nextName) => {
                        if (!nextName) {
                          return;
                        }
                        setSessionMenuOpen(false);
                        void kernel.sessionService.createNewSession(nextName).then(() => {
                          setAvailableSessions((prev) => (prev.includes(nextName) ? prev : [...prev, nextName]));
                        });
                      });
                  }}
                >
                  <FontAwesomeIcon icon={faPlus} />
                </button>
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
                  title="Save as..."
                  onClick={() => {
                    void props
                      .requestTextInput({
                        title: "Save Session As",
                        label: "Session name",
                        initialValue: state.activeSessionName,
                        confirmLabel: "Save"
                      })
                      .then((nextName) => {
                        if (!nextName) {
                          return;
                        }
                        setSessionMenuOpen(false);
                        void kernel.sessionService.saveAs(nextName).then(() => {
                          setAvailableSessions((prev) => (prev.includes(nextName) ? prev : [...prev, nextName]));
                        });
                      });
                  }}
                >
                  <FontAwesomeIcon icon={faBookmark} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="titlebar-right titlebar-interactive">
        <WindowControls />
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useKernel } from "@/app/useKernel";
import type { RecentsEntry } from "@/types/ipc";

interface WelcomeScreenProps {
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
}

export function WelcomeScreen({ requestTextInput }: WelcomeScreenProps) {
  const kernel = useKernel();
  const [recents, setRecents] = useState<RecentsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void kernel.projectService.loadRecents().then(setRecents);
  }, [kernel]);

  const refreshRecents = (): void => {
    void kernel.projectService.loadRecents().then(setRecents);
  };

  const reportError = (context: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    setError(`${context}: ${message}`);
  };

  const handleOpen = async (): Promise<void> => {
    if (!window.electronAPI) return;
    const picked = await window.electronAPI.selectSimularcaFile({ title: "Open Simularca project" });
    if (!picked) return;
    try {
      await kernel.projectService.openProject(picked);
    } catch (err) {
      reportError("Unable to open project", err);
    }
  };

  const handleNew = async (): Promise<void> => {
    if (!window.electronAPI) return;
    const defaultRoot = await window.electronAPI.getDefaultProjectsRoot();
    const parent = await window.electronAPI.selectFolder({
      title: "Choose a parent folder for the new project",
      defaultPath: defaultRoot
    });
    if (!parent) return;
    const projectName = await requestTextInput({
      title: "Create New Project",
      label: "Project name",
      initialValue: "untitled",
      confirmLabel: "Create"
    });
    if (!projectName) return;
    try {
      await kernel.projectService.createNewProject({ parentFolder: parent, projectName });
    } catch (err) {
      reportError("Unable to create project", err);
    }
  };

  const handleOpenRecent = async (entry: RecentsEntry): Promise<void> => {
    try {
      await kernel.projectService.openProject(entry.path, entry.lastSnapshotName);
    } catch (err) {
      reportError(`Unable to open "${entry.cachedName}"`, err);
    }
  };

  const handleLocateRecent = async (entry: RecentsEntry): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      const located = await window.electronAPI.locateRecent({
        uuid: entry.uuid,
        title: `Locate "${entry.cachedName}"`
      });
      if (located) refreshRecents();
    } catch (err) {
      reportError("Unable to locate project", err);
    }
  };

  const handleRemoveRecent = async (entry: RecentsEntry): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.removeRecent({ uuid: entry.uuid });
      refreshRecents();
    } catch (err) {
      reportError("Unable to remove recent", err);
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-screen-card">
        <h1>Welcome to Simularca</h1>
        <p>Open an existing project, create a new one, or pick from your recent projects below.</p>
        <div className="welcome-screen-buttons">
          <button type="button" onClick={() => void handleOpen()}>Open Project…</button>
          <button type="button" onClick={() => void handleNew()}>New Project…</button>
        </div>
        {error ? <p className="welcome-screen-error">{error}</p> : null}
        <h2>Recent Projects</h2>
        {recents.length === 0 ? (
          <p className="welcome-screen-empty">No recent projects yet.</p>
        ) : (
          <ul className="welcome-screen-recents">
            {recents.map((entry) => (
              <li key={entry.uuid} className="welcome-screen-recent">
                <button
                  type="button"
                  className="welcome-screen-recent-main"
                  title={entry.path}
                  onClick={() => void handleOpenRecent(entry)}
                >
                  <strong>{entry.cachedName}</strong>
                  <span className="welcome-screen-recent-path">{entry.path}</span>
                </button>
                <div className="welcome-screen-recent-actions">
                  <button type="button" onClick={() => void handleLocateRecent(entry)}>
                    Locate…
                  </button>
                  <button type="button" onClick={() => void handleRemoveRecent(entry)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

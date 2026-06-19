import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faClone,
  faFloppyDisk,
  faFolderOpen,
  faFolderPlus,
  faMagnifyingGlass,
  faPenToSquare,
  faRotateLeft,
  faStar,
  faTrash,
  faUpDownLeftRight,
  faUpRightFromSquare,
  faXmark
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { TitleBarBrand } from "@/ui/components/TitleBarBrand";
import { WindowControls } from "@/ui/components/WindowControls";
import type {
  DefaultProjectPointer,
  ProjectSnapshotListEntry,
  RecentsEntry
} from "@/types/ipc";

interface TitleBarPanelProps {
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
}

export function TitleBarPanel(props: TitleBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [recents, setRecents] = useState<RecentsEntry[]>([]);
  const [availableSnapshots, setAvailableSnapshots] = useState<ProjectSnapshotListEntry[]>([]);
  const [defaults, setDefaults] = useState<DefaultProjectPointer | null>(null);
  const [editingSnapshot, setEditingSnapshot] = useState<{
    mode: "create" | "rename";
    originalName: string | null;
    value: string;
    error: string | null;
  } | null>(null);
  const [editingSnapshotKey, setEditingSnapshotKey] = useState(0);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [snapshotQuery, setSnapshotQuery] = useState("");
  const [snapshotSort, setSnapshotSort] = useState<"recent" | "name">("recent");
  const [focusedProjectIndex, setFocusedProjectIndex] = useState<number | null>(null);
  const [focusedSnapshotIndex, setFocusedSnapshotIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const snapshotInputRef = useRef<HTMLInputElement | null>(null);
  const projectSearchRef = useRef<HTMLInputElement | null>(null);
  const projectListRef = useRef<HTMLDivElement | null>(null);
  const snapshotListRef = useRef<HTMLDivElement | null>(null);
  const isReadOnly = state.mode === "web-ro";
  const activeProject = state.activeProject;

  const snapshotOptions = useMemo(() => {
    if (availableSnapshots.some((entry) => entry.name === state.activeSnapshotName)) {
      return availableSnapshots;
    }
    return [{ name: state.activeSnapshotName, updatedAtIso: null }, ...availableSnapshots];
  }, [availableSnapshots, state.activeSnapshotName]);

  const filteredRecents = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((e) => e.cachedName.toLowerCase().includes(q));
  }, [recents, projectQuery]);

  const filteredSnapshotOptions = useMemo(() => {
    const q = snapshotQuery.trim().toLowerCase();
    const filtered = q
      ? snapshotOptions.filter((e) => e.name.toLowerCase().includes(q))
      : snapshotOptions;
    const sorted = filtered.slice();
    if (snapshotSort === "recent") {
      sorted.sort((a, b) => {
        const ta = a.updatedAtIso ? Date.parse(a.updatedAtIso) : Number.NEGATIVE_INFINITY;
        const tb = b.updatedAtIso ? Date.parse(b.updatedAtIso) : Number.NEGATIVE_INFINITY;
        if (tb !== ta) return tb - ta;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
    return sorted;
  }, [snapshotOptions, snapshotQuery, snapshotSort]);

  const isDefaultProject = (uuid: string): boolean => defaults?.uuid === uuid;

  const isDefaultSnapshot = (snapshotName: string): boolean =>
    Boolean(defaults && activeProject && defaults.uuid === activeProject.uuid && defaults.lastSnapshotName === snapshotName);

  const formatSnapshotDate = (updatedAtIso: string | null): string => {
    if (!updatedAtIso) {
      return "No saved date";
    }
    const date = new Date(updatedAtIso);
    if (Number.isNaN(date.getTime())) {
      return "Unknown date";
    }
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  };

  useEffect(() => {
    if (!activeProject) {
      setAvailableSnapshots([]);
      return;
    }
    let cancelled = false;
    const targetPath = activeProject.path;
    void kernel.projectService.listSnapshots(targetPath).then((entries) => {
      if (cancelled) return;
      setAvailableSnapshots(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [kernel, activeProject?.path, state.activeSnapshotName]);

  useEffect(() => {
    if (!isMenuOpen) {
      setProjectQuery("");
      setSnapshotQuery("");
      setFocusedProjectIndex(null);
      setFocusedSnapshotIndex(null);
      return;
    }
    void kernel.projectService.loadDefaults().then(setDefaults);
    void kernel.projectService.loadRecents().then(setRecents);
  }, [isMenuOpen, kernel]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const id = window.setTimeout(() => { projectSearchRef.current?.focus(); }, 0);
    return () => { window.clearTimeout(id); };
  }, [isMenuOpen]);

  useEffect(() => { setFocusedProjectIndex(null); }, [recents, projectQuery]);
  useEffect(() => { setFocusedSnapshotIndex(null); }, [snapshotOptions, snapshotQuery]);

  useEffect(() => {
    if (focusedProjectIndex === null || !projectListRef.current) return;
    const items = projectListRef.current.querySelectorAll<HTMLElement>("[data-project-item]");
    items[focusedProjectIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedProjectIndex]);

  useEffect(() => {
    if (focusedSnapshotIndex === null || !snapshotListRef.current) return;
    const items = snapshotListRef.current.querySelectorAll<HTMLElement>("[data-snapshot-item]");
    items[focusedSnapshotIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedSnapshotIndex]);

  useEffect(() => {
    if (!editingSnapshot) {
      return;
    }
    snapshotInputRef.current?.focus();
    snapshotInputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSnapshotKey]);

  useEffect(() => {
    if (isMenuOpen) {
      return;
    }
    setEditingSnapshot(null);
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isMenuOpen]);

  const refreshSnapshots = (): void => {
    const project = kernel.store.getState().state.activeProject;
    if (!project) {
      setAvailableSnapshots([]);
      return;
    }
    const targetPath = project.path;
    void kernel.projectService.listSnapshots(targetPath).then((entries) => {
      const current = kernel.store.getState().state.activeProject;
      if (current?.path !== targetPath) {
        return;
      }
      setAvailableSnapshots(entries);
    });
  };

  const refreshDefaults = (): void => {
    void kernel.projectService.loadDefaults().then(setDefaults);
  };

  const refreshRecents = (): void => {
    void kernel.projectService.loadRecents().then(setRecents);
  };

  const reportActionError = (context: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    kernel.store.getState().actions.setStatus(`${context}: ${message}`);
  };

  const handleProjectSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedProjectIndex((i) => (i === null ? 0 : Math.min(i + 1, filteredRecents.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedProjectIndex((i) => (i === null ? null : Math.max(i - 1, 0)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (focusedProjectIndex !== null && filteredRecents[focusedProjectIndex]) {
        void handleOpenRecent(filteredRecents[focusedProjectIndex]);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
    }
  };

  const handleSnapshotSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (editingSnapshot) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedSnapshotIndex((i) => (i === null ? 0 : Math.min(i + 1, filteredSnapshotOptions.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedSnapshotIndex((i) => (i === null ? null : Math.max(i - 1, 0)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (focusedSnapshotIndex !== null && filteredSnapshotOptions[focusedSnapshotIndex]) {
        setMenuOpen(false);
        void kernel.projectService.loadSnapshot(filteredSnapshotOptions[focusedSnapshotIndex].name);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
    }
  };

  const handleOpenProject = async (): Promise<void> => {
    if (!window.electronAPI) return;
    const picked = await window.electronAPI.selectSimularcaFile({ title: "Open Simularca project" });
    if (!picked) return;
    try {
      await kernel.projectService.openProject(picked);
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError("Unable to open project", error);
    }
  };

  const handleNewProject = async (): Promise<void> => {
    if (!window.electronAPI) return;
    const defaultRoot = await window.electronAPI.getDefaultProjectsRoot();
    const parent = await window.electronAPI.selectFolder({
      title: "Choose a parent folder for the new project",
      defaultPath: defaultRoot
    });
    if (!parent) return;
    const projectName = await props.requestTextInput({
      title: "Create New Project",
      label: "Project name",
      initialValue: "untitled",
      confirmLabel: "Create"
    });
    if (!projectName) return;
    try {
      await kernel.projectService.createNewProject({ parentFolder: parent, projectName });
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError("Unable to create project", error);
    }
  };

  const handleSaveProjectAs = async (): Promise<void> => {
    if (!window.electronAPI || !activeProject) return;
    const defaultRoot = await window.electronAPI.getDefaultProjectsRoot();
    const parent = await window.electronAPI.selectFolder({
      title: "Choose a parent folder for the new copy",
      defaultPath: defaultRoot
    });
    if (!parent) return;
    const newName = await props.requestTextInput({
      title: "Save Project As",
      label: "New project name",
      initialValue: `${activeProject.name}-copy`,
      confirmLabel: "Save As"
    });
    if (!newName) return;
    try {
      await kernel.projectService.saveProjectAs({ newParentFolder: parent, newProjectName: newName });
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError("Unable to save project as", error);
    }
  };

  const handleMoveProject = async (): Promise<void> => {
    if (!window.electronAPI || !activeProject) return;
    const defaultRoot = await window.electronAPI.getDefaultProjectsRoot();
    const parent = await window.electronAPI.selectFolder({
      title: "Move project to which folder?",
      defaultPath: defaultRoot
    });
    if (!parent) return;
    try {
      await kernel.projectService.moveProject(parent);
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError("Unable to move project", error);
    }
  };

  const handleRenameProject = async (): Promise<void> => {
    if (!activeProject) return;
    const nextName = await props.requestTextInput({
      title: "Rename Project",
      label: "Project name",
      initialValue: activeProject.name,
      confirmLabel: "Rename"
    });
    if (!nextName) return;
    try {
      await kernel.projectService.renameProject(nextName);
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError("Unable to rename project", error);
    }
  };

  const handleDeleteProject = (): void => {
    if (!activeProject) return;
    const confirmed = window.confirm(
      `Delete project "${activeProject.name}"?\n\nThis removes the entire folder at:\n${activeProject.path}` +
        (state.dirty ? "\n\nUnsaved changes will be lost." : "")
    );
    if (!confirmed) return;
    void kernel.projectService
      .deleteProject(activeProject.path)
      .then(() => {
        refreshSnapshots();
        refreshDefaults();
        refreshRecents();
        setMenuOpen(false);
      })
      .catch((error) => {
        reportActionError("Unable to delete project", error);
      });
  };

  const handleOpenRecent = async (entry: RecentsEntry): Promise<void> => {
    try {
      await kernel.projectService.openProject(entry.path, entry.lastSnapshotName);
      refreshSnapshots();
      refreshDefaults();
      refreshRecents();
      setMenuOpen(false);
    } catch (error) {
      reportActionError(`Unable to open "${entry.cachedName}"`, error);
    }
  };

  const handleLocateRecent = async (entry: RecentsEntry): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      const located = await window.electronAPI.locateRecent({
        uuid: entry.uuid,
        title: `Locate "${entry.cachedName}"`
      });
      if (located) {
        refreshRecents();
      }
    } catch (error) {
      reportActionError("Unable to locate project", error);
    }
  };

  const handleRevealRecent = async (entry: RecentsEntry): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.revealPath({ path: entry.path });
    } catch (error) {
      reportActionError("Unable to open project location", error);
    }
  };

  const handleRemoveRecent = async (entry: RecentsEntry): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.removeRecent({ uuid: entry.uuid });
      refreshRecents();
    } catch (error) {
      reportActionError("Unable to remove recent", error);
    }
  };

  const handleReloadSnapshot = (): void => {
    if (state.dirty) {
      const confirmed = window.confirm(
        "Discard unsaved changes and reload this snapshot from disk?"
      );
      if (!confirmed) {
        return;
      }
    }
    setMenuOpen(false);
    void kernel.projectService.loadSnapshot(state.activeSnapshotName);
  };

  const cancelSnapshotEdit = (): void => {
    setEditingSnapshot(null);
  };

  const validateSnapshotName = (nextName: string, originalName: string | null): string | null => {
    const trimmed = nextName.trim();
    if (!trimmed) {
      return "Snapshot name is required.";
    }
    const duplicate = snapshotOptions.some((entry) => entry.name === trimmed && entry.name !== originalName);
    if (duplicate) {
      return `Snapshot "${trimmed}" already exists.`;
    }
    return null;
  };

  const commitSnapshotEdit = async (): Promise<void> => {
    if (!editingSnapshot) {
      return;
    }
    const trimmed = editingSnapshot.value.trim();
    const error = validateSnapshotName(trimmed, editingSnapshot.originalName);
    if (error) {
      setEditingSnapshot((current) => (current ? { ...current, error } : current));
      return;
    }
    if (editingSnapshot.mode === "create") {
      try {
        await kernel.projectService.saveSnapshotAs(trimmed);
        refreshSnapshots();
        cancelSnapshotEdit();
      } catch (actionError) {
        reportActionError("Unable to create snapshot", actionError);
      }
      return;
    }
    if (!editingSnapshot.originalName || editingSnapshot.originalName === trimmed) {
      cancelSnapshotEdit();
      return;
    }
    try {
      await kernel.projectService.renameSnapshot(editingSnapshot.originalName, trimmed);
      refreshSnapshots();
      refreshDefaults();
      cancelSnapshotEdit();
    } catch (actionError) {
      reportActionError("Unable to rename snapshot", actionError);
    }
  };

  const startSnapshotRename = (snapshotName: string): void => {
    setEditingSnapshotKey((value) => value + 1);
    setEditingSnapshot({
      mode: "rename",
      originalName: snapshotName,
      value: snapshotName,
      error: null
    });
  };

  const startSnapshotCreate = (): void => {
    setEditingSnapshotKey((value) => value + 1);
    setEditingSnapshot({
      mode: "create",
      originalName: null,
      value: "",
      error: null
    });
  };

  const handleSnapshotInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitSnapshotEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelSnapshotEdit();
    }
  };

  // Note: deliberately no onBlur cancellation. Transient focus shifts (Electron
  // window focus quirks, repaint triggered re-renders, the project-search
  // setTimeout autofocus on menu open) would otherwise wipe the inline editor
  // before the user types a character. Cancellation happens via Escape or by
  // closing the menu (clicking outside clears editingSnapshot via the
  // isMenuOpen effect).

  const projectLabel = activeProject ? activeProject.name : "(no project)";

  return (
    <div className="titlebar">
      <div className="titlebar-left titlebar-interactive">
        <TitleBarBrand showDirtyBadge />
      </div>

      <div className="titlebar-center titlebar-interactive">
        <div className="titlebar-project" ref={menuRef}>
          <div className="titlebar-project-row">
            <button
              type="button"
              className="titlebar-project-trigger"
              title={activeProject ? `Project: ${activeProject.path}` : "No project open"}
              onClick={() => setMenuOpen((value) => !value)}
            >
              Project: <strong>{projectLabel}</strong> / Snapshot: <strong>{state.activeSnapshotName}</strong>
              {state.dirty ? <em>*</em> : null}
            </button>
            {state.dirty && activeProject ? (
              <>
                <button
                  type="button"
                  className="titlebar-project-save-stale"
                  disabled={isReadOnly}
                  title="Save project"
                  onClick={() => {
                    void kernel.projectService.saveProject();
                  }}
                >
                  <FontAwesomeIcon icon={faFloppyDisk} />
                </button>
                <button
                  type="button"
                  className="titlebar-project-save-stale"
                  title="Revert: discard changes and reload the last saved snapshot"
                  onClick={handleReloadSnapshot}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                </button>
              </>
            ) : null}
          </div>
          {isMenuOpen ? (
            <div className="titlebar-project-popover">
              <div className="titlebar-project-section">
                <label>Recent Projects</label>
                <div className="titlebar-popover-search">
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                  <input
                    ref={projectSearchRef}
                    type="text"
                    value={projectQuery}
                    placeholder="Filter projects..."
                    onChange={(event) => { setProjectQuery(event.target.value); }}
                    onKeyDown={handleProjectSearchKeyDown}
                  />
                </div>
                <div ref={projectListRef} className="titlebar-project-list" role="listbox" aria-label="Recent projects">
                  {filteredRecents.length === 0 ? (
                    <div className="titlebar-project-list-empty">
                      {projectQuery ? "No matching projects." : "No recent projects."}
                    </div>
                  ) : null}
                  {filteredRecents.map((entry, index) => {
                    const isActive = activeProject?.uuid === entry.uuid;
                    const isFocused = focusedProjectIndex === index;
                    return (
                      <div
                        key={entry.uuid}
                        data-project-item=""
                        className={`titlebar-project-list-item${isActive ? " is-active" : ""}${isFocused ? " is-focused" : ""}`}
                      >
                        <button
                          type="button"
                          className="titlebar-project-list-main"
                          aria-selected={isActive}
                          title={entry.path}
                          onClick={() => {
                            void handleOpenRecent(entry);
                          }}
                        >
                          <span className="titlebar-project-list-name">{entry.cachedName}</span>
                        </button>
                        <div className="titlebar-project-list-side">
                          <div className="titlebar-project-actions-inline">
                            <button
                              type="button"
                              className="titlebar-project-action"
                              title="Open project location on disk"
                              onClick={() => {
                                void handleRevealRecent(entry);
                              }}
                            >
                              <FontAwesomeIcon icon={faUpRightFromSquare} />
                            </button>
                            <button
                              type="button"
                              className="titlebar-project-action"
                              title="Locate moved project"
                              onClick={() => {
                                void handleLocateRecent(entry);
                              }}
                            >
                              <FontAwesomeIcon icon={faMagnifyingGlass} />
                            </button>
                            <button
                              type="button"
                              className="titlebar-project-action"
                              title="Remove from recents"
                              onClick={() => {
                                void handleRemoveRecent(entry);
                              }}
                            >
                              <FontAwesomeIcon icon={faXmark} />
                            </button>
                          </div>
                          {isReadOnly ? (
                            <span className="titlebar-project-list-indicator" aria-hidden="true">
                              {isDefaultProject(entry.uuid) ? <FontAwesomeIcon icon={faStar} /> : null}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={`titlebar-project-action titlebar-star-button${
                                isDefaultProject(entry.uuid) ? " is-default" : " is-empty"
                              }`}
                              aria-pressed={isDefaultProject(entry.uuid)}
                              title={
                                isDefaultProject(entry.uuid)
                                  ? "Default project (click to unset)"
                                  : "Set as default project"
                              }
                              onClick={() => {
                                const starred = isDefaultProject(entry.uuid);
                                const snapshotName = isActive
                                  ? state.activeSnapshotName
                                  : entry.lastSnapshotName;
                                void kernel.projectService
                                  .setDefault(
                                    starred
                                      ? null
                                      : {
                                          uuid: entry.uuid,
                                          path: entry.path,
                                          lastSnapshotName: snapshotName
                                        }
                                  )
                                  .then(refreshDefaults);
                              }}
                            >
                              <FontAwesomeIcon icon={faStar} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="titlebar-project-actions">
                  <button
                    type="button"
                    title="Open project from disk"
                    onClick={() => {
                      void handleOpenProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faFolderOpen} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly}
                    title="New project"
                    onClick={() => {
                      void handleNewProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faFolderPlus} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Save project"
                    onClick={() => {
                      setMenuOpen(false);
                      void kernel.projectService.saveProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faFloppyDisk} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Save project as…"
                    onClick={() => {
                      void handleSaveProjectAs();
                    }}
                  >
                    <FontAwesomeIcon icon={faClone} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Rename project"
                    onClick={() => {
                      void handleRenameProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faPenToSquare} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Move project to a new folder"
                    onClick={() => {
                      void handleMoveProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faUpDownLeftRight} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Set as default project"
                    onClick={() => {
                      setMenuOpen(false);
                      void kernel.projectService.setDefaultProject().then(refreshDefaults);
                    }}
                  >
                    <FontAwesomeIcon icon={faStar} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly || !activeProject}
                    title="Delete project"
                    onClick={handleDeleteProject}
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </div>
              </div>

              {activeProject ? (
                <>
                  <div className="titlebar-project-divider" />
                  <div className="titlebar-project-section">
                    <label>Active Snapshot</label>
                    <div className="titlebar-popover-search">
                      <FontAwesomeIcon icon={faMagnifyingGlass} />
                      <input
                        type="text"
                        value={snapshotQuery}
                        placeholder="Filter snapshots..."
                        onChange={(event) => { setSnapshotQuery(event.target.value); }}
                        onKeyDown={handleSnapshotSearchKeyDown}
                      />
                      <div className="titlebar-popover-sort" role="group" aria-label="Sort snapshots">
                        <button
                          type="button"
                          className={`titlebar-popover-sort-option${snapshotSort === "recent" ? " is-active" : ""}`}
                          aria-pressed={snapshotSort === "recent"}
                          title="Sort by most recently edited"
                          onClick={() => { setSnapshotSort("recent"); }}
                        >
                          Recent
                        </button>
                        <button
                          type="button"
                          className={`titlebar-popover-sort-option${snapshotSort === "name" ? " is-active" : ""}`}
                          aria-pressed={snapshotSort === "name"}
                          title="Sort alphabetically by name"
                          onClick={() => { setSnapshotSort("name"); }}
                        >
                          Name
                        </button>
                      </div>
                    </div>
                    <div ref={snapshotListRef} className="titlebar-project-snapshot-list" role="listbox" aria-label="Project snapshots">
                      {!snapshotQuery ? (
                        editingSnapshot?.mode === "create" ? (
                          <div className="titlebar-project-snapshot-item is-editing">
                            <div className="titlebar-project-snapshot-editor">
                              <input
                                ref={snapshotInputRef}
                                type="text"
                                className="titlebar-project-snapshot-input"
                                value={editingSnapshot.value}
                                placeholder="New snapshot name"
                                aria-label="New snapshot name"
                                onChange={(event) => {
                                  const nextValue = event.target.value;
                                  setEditingSnapshot((current) =>
                                    current
                                      ? {
                                          ...current,
                                          value: nextValue,
                                          error: validateSnapshotName(nextValue, current.originalName)
                                        }
                                      : current
                                  );
                                }}
                                onKeyDown={handleSnapshotInputKeyDown}
                              />
                              {editingSnapshot.error ? (
                                <span className="titlebar-project-snapshot-error">{editingSnapshot.error}</span>
                              ) : null}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="titlebar-project-new-snapshot"
                            disabled={isReadOnly}
                            onClick={() => {
                              startSnapshotCreate();
                            }}
                          >
                            <span>New snapshot...</span>
                          </button>
                        )
                      ) : null}
                      {filteredSnapshotOptions.map((snapshot, index) => {
                        const isActive = snapshot.name === state.activeSnapshotName;
                        const isFocused = focusedSnapshotIndex === index;
                        const isEditing =
                          editingSnapshot?.mode === "rename" && editingSnapshot.originalName === snapshot.name;
                        if (isEditing && editingSnapshot) {
                          return (
                            <div
                              key={snapshot.name}
                              className="titlebar-project-snapshot-item is-editing"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <div className="titlebar-project-snapshot-editor">
                                <input
                                  ref={snapshotInputRef}
                                  type="text"
                                  className="titlebar-project-snapshot-input"
                                  value={editingSnapshot.value}
                                  aria-label={`Rename snapshot ${snapshot.name}`}
                                  onChange={(event) => {
                                    const nextValue = event.target.value;
                                    setEditingSnapshot((current) =>
                                      current
                                        ? {
                                            ...current,
                                            value: nextValue,
                                            error: validateSnapshotName(nextValue, current.originalName)
                                          }
                                        : current
                                    );
                                  }}
                                  onKeyDown={handleSnapshotInputKeyDown}
                                />
                                {editingSnapshot.error ? (
                                  <span className="titlebar-project-snapshot-error">{editingSnapshot.error}</span>
                                ) : null}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={snapshot.name}
                            data-snapshot-item=""
                            className={`titlebar-project-snapshot-item${isActive ? " is-active" : ""}${isFocused ? " is-focused" : ""}`}
                          >
                            <button
                              type="button"
                              className="titlebar-project-snapshot-main"
                              aria-selected={isActive}
                              onClick={() => {
                                setMenuOpen(false);
                                void kernel.projectService.loadSnapshot(snapshot.name);
                              }}
                            >
                              <span className="titlebar-project-snapshot-name">{snapshot.name}</span>
                              <span className="titlebar-project-snapshot-date">
                                {formatSnapshotDate(snapshot.updatedAtIso)}
                              </span>
                            </button>
                            <div className="titlebar-project-snapshot-side">
                              {isReadOnly ? (
                                <span className="titlebar-project-snapshot-default-indicator" aria-hidden="true">
                                  {isDefaultSnapshot(snapshot.name) ? <FontAwesomeIcon icon={faStar} /> : null}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className={`titlebar-project-snapshot-action titlebar-star-button${
                                    isDefaultSnapshot(snapshot.name) ? " is-default" : " is-empty"
                                  }`}
                                  aria-pressed={isDefaultSnapshot(snapshot.name)}
                                  title={
                                    isDefaultSnapshot(snapshot.name)
                                      ? "Default snapshot (click to unset)"
                                      : "Set as default snapshot"
                                  }
                                  onClick={() => {
                                    if (!activeProject) {
                                      return;
                                    }
                                    const starred = isDefaultSnapshot(snapshot.name);
                                    void kernel.projectService
                                      .setDefault(
                                        starred
                                          ? null
                                          : {
                                              uuid: activeProject.uuid,
                                              path: activeProject.path,
                                              lastSnapshotName: snapshot.name
                                            }
                                      )
                                      .then(refreshDefaults);
                                  }}
                                >
                                  <FontAwesomeIcon icon={faStar} />
                                </button>
                              )}
                              {!isReadOnly ? (
                                <div className="titlebar-project-snapshot-actions">
                                  <button
                                    type="button"
                                    className="titlebar-project-snapshot-action"
                                    title="Rename snapshot"
                                    onClick={() => {
                                      startSnapshotRename(snapshot.name);
                                    }}
                                  >
                                    <FontAwesomeIcon icon={faPenToSquare} />
                                  </button>
                                  <button
                                    type="button"
                                    className="titlebar-project-snapshot-action"
                                    title="Delete snapshot"
                                    disabled={snapshotOptions.length <= 1}
                                    onClick={() => {
                                      const confirmed = window.confirm(`Delete snapshot "${snapshot.name}"?`);
                                      if (!confirmed) {
                                        return;
                                      }
                                      void kernel.projectService.deleteSnapshot(snapshot.name).then(() => {
                                        refreshSnapshots();
                                        refreshDefaults();
                                      });
                                    }}
                                  >
                                    <FontAwesomeIcon icon={faTrash} />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="titlebar-project-actions">
                    <button
                      type="button"
                      title="Revert: discard changes and reload the last saved snapshot"
                      onClick={handleReloadSnapshot}
                    >
                      <FontAwesomeIcon icon={faRotateLeft} />
                    </button>
                  </div>
                </>
              ) : null}
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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircleInfo,
  faClone,
  faFloppyDisk,
  faPenToSquare,
  faPlus,
  faRotateRight,
  faStar,
  faTrash
} from "@fortawesome/free-solid-svg-icons";
import { BUILD_INFO, formatBuildTimestamp } from "@/app/buildInfo";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { AboutModal } from "@/ui/components/AboutModal";
import { GitDirtyBadge } from "@/ui/components/GitDirtyBadge";
import { WindowControls } from "@/ui/components/WindowControls";
import { useGitDirtyStatus } from "@/ui/useGitDirtyStatus";
import type { DefaultProjectPointer, ProjectSnapshotListEntry } from "@/types/ipc";
import appIconUrl from "../../../icon.png";

const APP_NAME = "Simularca";

interface TitleBarPanelProps {
  requestTextInput(args: {
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
  }): Promise<string | null>;
}

function nextUntitledName(existingNames: string[], baseName: string): string {
  const used = new Set(existingNames);
  if (!used.has(baseName)) {
    return baseName;
  }
  let index = 2;
  while (used.has(`${baseName}-${String(index)}`)) {
    index += 1;
  }
  return `${baseName}-${String(index)}`;
}

export function TitleBarPanel(props: TitleBarPanelProps) {
  const kernel = useKernel();
  const state = useAppStore((store) => store.state);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [availableSnapshots, setAvailableSnapshots] = useState<ProjectSnapshotListEntry[]>([]);
  const [defaults, setDefaults] = useState<DefaultProjectPointer>({
    defaultProjectName: state.activeProjectName,
    defaultSnapshotName: state.activeSnapshotName
  });
  const [editingSnapshot, setEditingSnapshot] = useState<{
    mode: "create" | "rename";
    originalName: string | null;
    value: string;
    error: string | null;
  } | null>(null);
  const [editingSnapshotKey, setEditingSnapshotKey] = useState(0);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const snapshotInputRef = useRef<HTMLInputElement | null>(null);
  const isReadOnly = state.mode === "web-ro";
  const buildMeta = `${BUILD_INFO.commitShortSha || "unknown"} | ${formatBuildTimestamp(BUILD_INFO.buildTimestampIso)}`;
  const gitDirtyStatus = useGitDirtyStatus([]);

  const projectOptions = useMemo(() => {
    if (availableProjects.includes(state.activeProjectName)) {
      return availableProjects;
    }
    return [state.activeProjectName, ...availableProjects];
  }, [availableProjects, state.activeProjectName]);

  const snapshotOptions = useMemo(() => {
    if (availableSnapshots.some((entry) => entry.name === state.activeSnapshotName)) {
      return availableSnapshots;
    }
    return [{ name: state.activeSnapshotName, updatedAtIso: null }, ...availableSnapshots];
  }, [availableSnapshots, state.activeSnapshotName]);

  const isDefaultProject = (projectName: string): boolean => defaults.defaultProjectName === projectName;

  const isDefaultSnapshot = (snapshotName: string): boolean =>
    defaults.defaultProjectName === state.activeProjectName && defaults.defaultSnapshotName === snapshotName;

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
    void kernel.projectService.listProjects().then(setAvailableProjects);
  }, [kernel, state.activeProjectName]);

  useEffect(() => {
    void kernel.projectService.listSnapshots(state.activeProjectName).then(setAvailableSnapshots);
  }, [kernel, state.activeProjectName, state.activeSnapshotName]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    void kernel.projectService.loadDefaultsPointer().then(setDefaults);
  }, [isMenuOpen, kernel]);

  useEffect(() => {
    if (!editingSnapshot) {
      return;
    }
    snapshotInputRef.current?.focus();
    snapshotInputRef.current?.select();
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

  const refreshProjects = (): void => {
    void kernel.projectService.listProjects().then(setAvailableProjects);
  };

  const refreshSnapshots = (): void => {
    void kernel.projectService.listSnapshots(state.activeProjectName).then(setAvailableSnapshots);
  };

  const refreshDefaults = (): void => {
    void kernel.projectService.loadDefaultsPointer().then(setDefaults);
  };

  const reportActionError = (context: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    kernel.store.getState().actions.setStatus(`${context}: ${message}`);
  };

  const suggestProjectCopyName = (projectName: string): string =>
    nextUntitledName(projectOptions, `${projectName}-copy`);

  const handleProjectSaveAs = (sourceProjectName: string): void => {
    void props
      .requestTextInput({
        title: "Save Project As",
        label: "Project name",
        initialValue: suggestProjectCopyName(sourceProjectName),
        confirmLabel: "Save As"
      })
      .then(async (nextName) => {
        if (!nextName) {
          return;
        }
        try {
          await kernel.projectService.saveProjectAs(nextName);
          refreshProjects();
          refreshSnapshots();
          refreshDefaults();
          setMenuOpen(false);
        } catch (error) {
          reportActionError("Unable to save project as", error);
        }
      });
  };

  const handleDuplicateProject = (sourceProjectName: string): void => {
    void props
      .requestTextInput({
        title: "Duplicate Project",
        label: "Project name",
        initialValue: suggestProjectCopyName(sourceProjectName),
        confirmLabel: "Duplicate"
      })
      .then(async (nextName) => {
        if (!nextName) {
          return;
        }
        try {
          await kernel.projectService.duplicateProject(sourceProjectName, nextName);
          refreshProjects();
          refreshDefaults();
        } catch (error) {
          reportActionError("Unable to duplicate project", error);
        }
      });
  };

  const handleDeleteProject = (projectName: string): void => {
    const activeWarning =
      projectName === state.activeProjectName && state.dirty ? "\n\nUnsaved changes in the current project will be lost." : "";
    const confirmed = window.confirm(`Delete project "${projectName}"?${activeWarning}`);
    if (!confirmed) {
      return;
    }
    void kernel.projectService
      .deleteProject(projectName)
      .then(() => {
        refreshProjects();
        refreshSnapshots();
        refreshDefaults();
      })
      .catch((error) => {
        reportActionError("Unable to delete project", error);
      });
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

  const handleSnapshotInputBlur = (): void => {
    cancelSnapshotEdit();
  };

  return (
    <div className="titlebar">
      <div className="titlebar-left titlebar-interactive">
        <div className="titlebar-app-icon" aria-hidden="true">
          <img src={appIconUrl} alt="" />
        </div>
        <button
          type="button"
          className="titlebar-brand-button"
          title={BUILD_INFO.commitSubject}
          onClick={() => {
            setAboutOpen(true);
          }}
        >
          <div className="titlebar-brand">
            <strong>{APP_NAME}</strong>
            <span>v{BUILD_INFO.version}</span>
            <span className="titlebar-build-meta">
              {buildMeta}
              <GitDirtyBadge count={gitDirtyStatus.app?.changedFileCount ?? 0} className="git-dirty-badge titlebar-git-dirty-badge" />
            </span>
          </div>
          <FontAwesomeIcon icon={faCircleInfo} />
        </button>
      </div>

      <div className="titlebar-center titlebar-interactive">
        <div className="titlebar-project" ref={menuRef}>
          <div className="titlebar-project-row">
            <button
              type="button"
              className="titlebar-project-trigger"
              title="Switch project or snapshot"
              onClick={() => setMenuOpen((value) => !value)}
            >
              Project: <strong>{state.activeProjectName}</strong> / Snapshot: <strong>{state.activeSnapshotName}</strong>
              {state.dirty ? <em>*</em> : null}
            </button>
            {state.dirty ? (
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
            ) : null}
          </div>
          {isMenuOpen ? (
            <div className="titlebar-project-popover">
              <div className="titlebar-project-section">
                <label>Active Project</label>
                <div className="titlebar-project-list" role="listbox" aria-label="Projects">
                  {projectOptions.map((projectName) => {
                    const isActive = projectName === state.activeProjectName;
                    return (
                      <div
                        key={projectName}
                        className={`titlebar-project-list-item${isActive ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="titlebar-project-list-main"
                          aria-selected={isActive}
                          onClick={() => {
                            setMenuOpen(false);
                            void kernel.projectService.loadProject(projectName, "main");
                          }}
                        >
                          <span className="titlebar-project-list-name">{projectName}</span>
                        </button>
                        <div className="titlebar-project-list-side">
                          {!isReadOnly ? (
                            <div className="titlebar-project-actions-inline">
                              <button
                                type="button"
                                className={`titlebar-project-action${isDefaultProject(projectName) ? " is-active" : ""}`}
                                title="Set as default project"
                                onClick={() => {
                                  void kernel.projectService.setDefaultSnapshot("main", projectName).then(() => {
                                    refreshDefaults();
                                  });
                                }}
                              >
                                <FontAwesomeIcon icon={faStar} />
                              </button>
                              <button
                                type="button"
                                className="titlebar-project-action"
                                title="Duplicate project"
                                onClick={() => {
                                  handleDuplicateProject(projectName);
                                }}
                              >
                                <FontAwesomeIcon icon={faClone} />
                              </button>
                              <button
                                type="button"
                                className="titlebar-project-action"
                                title="Delete project"
                                onClick={() => {
                                  handleDeleteProject(projectName);
                                }}
                              >
                                <FontAwesomeIcon icon={faTrash} />
                              </button>
                            </div>
                          ) : null}
                          <span className="titlebar-project-list-indicator" aria-hidden="true">
                            {isDefaultProject(projectName) ? <FontAwesomeIcon icon={faStar} /> : null}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="titlebar-project-actions">
                  <button
                    type="button"
                    disabled={isReadOnly}
                    title="New project"
                    onClick={() => {
                      void props
                        .requestTextInput({
                          title: "Create New Project",
                          label: "Project name",
                          initialValue: nextUntitledName(projectOptions, "untitled"),
                          confirmLabel: "Create"
                        })
                        .then(async (nextName) => {
                          if (!nextName) {
                            return;
                          }
                          try {
                            await kernel.projectService.createNewProject(nextName);
                            refreshProjects();
                            refreshSnapshots();
                            refreshDefaults();
                            setMenuOpen(false);
                          } catch (error) {
                            reportActionError("Unable to create project", error);
                          }
                        });
                    }}
                  >
                    <FontAwesomeIcon icon={faPlus} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly}
                    title="Save project as"
                    onClick={() => {
                      handleProjectSaveAs(state.activeProjectName);
                    }}
                  >
                    <FontAwesomeIcon icon={faClone} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly}
                    title="Rename project"
                    onClick={() => {
                      void props
                        .requestTextInput({
                          title: "Rename Project",
                          label: "Project name",
                          initialValue: state.activeProjectName,
                          confirmLabel: "Rename"
                        })
                        .then(async (nextName) => {
                          if (!nextName) {
                            return;
                          }
                          try {
                            await kernel.projectService.renameProject(state.activeProjectName, nextName);
                            refreshProjects();
                            refreshSnapshots();
                            refreshDefaults();
                            setMenuOpen(false);
                          } catch (error) {
                            reportActionError("Unable to rename project", error);
                          }
                        });
                    }}
                  >
                    <FontAwesomeIcon icon={faPenToSquare} />
                  </button>
                  <button
                    type="button"
                    disabled={isReadOnly}
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
                    disabled={isReadOnly}
                    title="Set as default project"
                    onClick={() => {
                      setMenuOpen(false);
                      void kernel.projectService.setDefaultProject();
                    }}
                  >
                    <FontAwesomeIcon icon={faStar} />
                  </button>
                </div>
              </div>

              <div className="titlebar-project-divider" />

              <div className="titlebar-project-section">
                <label>Active Snapshot</label>
                <div className="titlebar-project-snapshot-list" role="listbox" aria-label="Project snapshots">
                  {snapshotOptions.map((snapshot) => {
                    const isActive = snapshot.name === state.activeSnapshotName;
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
                              onBlur={handleSnapshotInputBlur}
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
                        className={`titlebar-project-snapshot-item${isActive ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="titlebar-project-snapshot-main"
                          aria-selected={isActive}
                          onClick={() => {
                            setMenuOpen(false);
                            void kernel.projectService.loadProject(state.activeProjectName, snapshot.name);
                          }}
                        >
                          <span className="titlebar-project-snapshot-name">{snapshot.name}</span>
                          <span className="titlebar-project-snapshot-date">{formatSnapshotDate(snapshot.updatedAtIso)}</span>
                        </button>
                        <div className="titlebar-project-snapshot-side">
                          <span className="titlebar-project-snapshot-default-indicator" aria-hidden="true">
                            {isDefaultSnapshot(snapshot.name) ? <FontAwesomeIcon icon={faStar} /> : null}
                          </span>
                          {!isReadOnly ? (
                            <div className="titlebar-project-snapshot-actions">
                              <button
                                type="button"
                                className={`titlebar-project-snapshot-action${isDefaultSnapshot(snapshot.name) ? " is-active" : ""}`}
                                title="Set as default snapshot"
                                onClick={() => {
                                  void kernel.projectService.setDefaultSnapshot(snapshot.name, state.activeProjectName).then(() => {
                                    refreshDefaults();
                                  });
                                }}
                              >
                                <FontAwesomeIcon icon={faStar} />
                              </button>
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
                  {editingSnapshot?.mode === "create" ? (
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
                          onBlur={handleSnapshotInputBlur}
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
                  )}
                </div>
              </div>

              <div className="titlebar-project-actions">
                <button
                  type="button"
                  title="Reload current snapshot"
                  onClick={() => {
                    if (state.dirty) {
                      const confirmed = window.confirm("Discard unsaved changes and reload this snapshot from disk?");
                      if (!confirmed) {
                        return;
                      }
                    }
                    setMenuOpen(false);
                    void kernel.projectService.loadProject(state.activeProjectName, state.activeSnapshotName);
                  }}
                >
                  <FontAwesomeIcon icon={faRotateRight} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="titlebar-right titlebar-interactive">
        <WindowControls />
      </div>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}



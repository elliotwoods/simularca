import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faAnglesRight,
  faCheck,
  faClone,
  faFolderOpen,
  faPaste,
  faTrash,
  faTriangleExclamation,
  faXmark
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import type { LegacyProjectInfo } from "@/types/ipc";

interface MigrationModalProps {
  legacy: LegacyProjectInfo[];
  onComplete(): void;
}

type RowStatus = "pending" | "running" | "succeeded" | "failed";

interface Row {
  info: LegacyProjectInfo;
  target: string;
  selected: boolean;
  status: RowStatus;
  errorMessage?: string;
  pasteError?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncatePathMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Bias toward keeping the end (the meaningful project folder name).
  const ellipsis = " … ";
  const budget = maxChars - ellipsis.length;
  const startLen = Math.max(8, Math.floor(budget * 0.4));
  const endLen = Math.max(8, budget - startLen);
  return `${value.slice(0, startLen)}${ellipsis}${value.slice(value.length - endLen)}`;
}

export function MigrationModal({ legacy, onComplete }: MigrationModalProps) {
  const kernel = useKernel();
  const [defaultTarget, setDefaultTarget] = useState<string>("");
  const [rows, setRows] = useState<Row[]>(() =>
    legacy.map((info) => ({ info, target: "", selected: false, status: "pending" as RowStatus }))
  );
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!window.electronAPI) return;
      const root = await window.electronAPI.getDefaultProjectsRoot();
      setDefaultTarget(root);
      setRows((prev) => prev.map((row) => (row.target ? row : { ...row, target: root })));
    })();
  }, []);

  const setRowTarget = async (index: number): Promise<void> => {
    if (!window.electronAPI) return;
    const current = rows[index];
    if (!current) return;
    const picked = await window.electronAPI.selectFolder({
      title: `Target folder for "${current.info.legacyName}"`,
      defaultPath: current.target || defaultTarget
    });
    if (!picked) return;
    setRows((prev) => prev.map((row, idx) => (idx === index ? { ...row, target: picked } : row)));
  };

  const copyTarget = async (index: number): Promise<void> => {
    const row = rows[index];
    if (!row || !row.target) return;
    try {
      await navigator.clipboard.writeText(row.target);
    } catch {
      // Best-effort.
    }
  };

  const pasteTarget = async (index: number): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        setRows((prev) =>
          prev.map((row, idx) => (idx === index ? { ...row, pasteError: "Clipboard is empty." } : row))
        );
        return;
      }
      setRows((prev) =>
        prev.map((row, idx) => (idx === index ? { ...row, target: text.trim(), pasteError: undefined } : row))
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clipboard read failed.";
      setRows((prev) =>
        prev.map((row, idx) => (idx === index ? { ...row, pasteError: message } : row))
      );
    }
  };

  const toggleRowSelected = (index: number): void => {
    setRows((prev) => prev.map((row, idx) => (idx === index ? { ...row, selected: !row.selected } : row)));
  };

  const toggleAllSelected = (): void => {
    const allSelected = rows.every((row) => row.selected || row.status !== "pending");
    setRows((prev) =>
      prev.map((row) => (row.status === "pending" ? { ...row, selected: !allSelected } : row))
    );
  };

  const deleteRow = async (index: number): Promise<void> => {
    const row = rows[index];
    if (!row) return;
    const confirmed = window.confirm(
      `Delete legacy project "${row.info.legacyName}"?\n\n` +
        `This permanently removes the folder under savedata/ — ${row.info.snapshotCount} snapshots, ${formatBytes(row.info.totalBytes)}. Cannot be undone.`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await kernel.storage.deleteLegacyProject(row.info.legacyName);
      setRows((prev) => prev.filter((_, idx) => idx !== index));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRows((prev) =>
        prev.map((r, idx) => (idx === index ? { ...r, errorMessage: message } : r))
      );
    } finally {
      setBusy(false);
    }
  };

  const migrateSelected = async (): Promise<void> => {
    const todo = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.selected && row.status === "pending" && row.target.trim().length > 0);
    if (todo.length === 0) return;
    setBusy(true);
    for (const { row, index } of todo) {
      setRows((prev) =>
        prev.map((r, idx) => (idx === index ? { ...r, status: "running", errorMessage: undefined } : r))
      );
      try {
        const identity = await kernel.storage.migrateLegacyProject({
          legacyName: row.info.legacyName,
          targetParentFolder: row.target
        });
        // Promote the freshly-migrated project into recents so the welcome screen
        // and Open Recent menus surface it without needing a re-open.
        try {
          const existing = await kernel.storage.loadRecents();
          const filtered = existing.filter((entry) => entry.uuid !== identity.uuid);
          const next = [
            {
              uuid: identity.uuid,
              path: identity.path,
              cachedName: identity.name,
              lastOpenedAtIso: new Date().toISOString(),
              lastSnapshotName: null
            },
            ...filtered
          ].slice(0, 20);
          await kernel.storage.saveRecents(next);
        } catch {
          // Best-effort — recents persist on next open if this fails.
        }
        setRows((prev) =>
          prev.map((r, idx) => (idx === index ? { ...r, status: "succeeded", selected: false } : r))
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === index ? { ...r, status: "failed", errorMessage: message, selected: false } : r
          )
        );
      }
    }
    setBusy(false);
  };

  const closeModal = async (): Promise<void> => {
    if (closing) return;
    setClosing(true);
    const failed = rows.filter((r) => r.status === "failed").map((r) => r.info.legacyName);
    const skipped = rows.filter((r) => r.status === "pending").map((r) => r.info.legacyName);
    try {
      await kernel.storage.writeMigrationReadme({
        failedProjectNames: failed,
        skippedProjectNames: skipped
      });
    } catch {
      // Best-effort.
    }
    onComplete();
  };

  // Auto-close when nothing remains (e.g. all rows were deleted).
  useEffect(() => {
    if (rows.length === 0 && !closing) {
      void closeModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const selectedPendingCount = useMemo(
    () => rows.filter((r) => r.selected && r.status === "pending" && r.target.trim().length > 0).length,
    [rows]
  );
  const selectedWithoutTargetCount = useMemo(
    () => rows.filter((r) => r.selected && r.status === "pending" && r.target.trim().length === 0).length,
    [rows]
  );
  const allSelectedCheckbox =
    rows.length > 0 && rows.every((row) => row.selected || row.status !== "pending");

  return (
    <div className="migration-modal-backdrop">
      <div className="migration-modal">
        <header>
          <h3>Migrate Legacy Projects</h3>
        </header>
        <div className="migration-modal-body">
          <p className="migration-modal-intro">
            Project storage has moved. Pick a folder for each project below (anywhere on disk —
            cloud-synced folders are fine), tick the rows you want to migrate, then click{" "}
            <strong>Migrate Selected</strong>. Skipped or failed rows reappear next launch.
          </p>

          <div className="migration-modal-table" role="table">
            <div className="migration-modal-row migration-modal-head" role="row">
              <div className="migration-modal-cell migration-modal-cell-check">
                <input
                  type="checkbox"
                  checked={allSelectedCheckbox}
                  onChange={toggleAllSelected}
                  aria-label="Select all pending rows"
                  disabled={busy || rows.every((row) => row.status !== "pending")}
                />
              </div>
              <div className="migration-modal-cell migration-modal-cell-name">Project</div>
              <div className="migration-modal-cell migration-modal-cell-target">Target folder</div>
              <div className="migration-modal-cell migration-modal-cell-actions">Actions</div>
              <div className="migration-modal-cell migration-modal-cell-status">Status</div>
            </div>
            {rows.map((row, index) => {
              const targetDisplay = row.target ? truncatePathMiddle(row.target, 48) : "Choose folder…";
              const rowDisabled = busy || row.status === "running" || row.status === "succeeded";
              return (
                <div
                  key={row.info.legacyName}
                  className={`migration-modal-row migration-modal-data-row${
                    row.status === "succeeded" ? " is-succeeded" : ""
                  }${row.status === "failed" ? " is-failed" : ""}`}
                  role="row"
                >
                  <div className="migration-modal-cell migration-modal-cell-check">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={() => toggleRowSelected(index)}
                      aria-label={`Select ${row.info.legacyName}`}
                      disabled={rowDisabled}
                    />
                  </div>
                  <div className="migration-modal-cell migration-modal-cell-name">
                    <div className="migration-modal-name-main">{row.info.legacyName}</div>
                    <div className="migration-modal-name-meta">
                      {row.info.snapshotCount} snapshots · {formatBytes(row.info.totalBytes)}
                    </div>
                  </div>
                  <div className="migration-modal-cell migration-modal-cell-target">
                    <button
                      type="button"
                      className="migration-modal-target-button"
                      title={row.target || "Choose folder…"}
                      onClick={() => void setRowTarget(index)}
                      disabled={rowDisabled}
                    >
                      <FontAwesomeIcon icon={faFolderOpen} />
                      <span className="migration-modal-target-text">{targetDisplay}</span>
                    </button>
                    {row.pasteError ? (
                      <div className="migration-modal-row-error">{row.pasteError}</div>
                    ) : null}
                  </div>
                  <div className="migration-modal-cell migration-modal-cell-actions">
                    <button
                      type="button"
                      className="migration-modal-icon-button"
                      title="Copy target folder"
                      onClick={() => void copyTarget(index)}
                      disabled={rowDisabled || !row.target}
                    >
                      <FontAwesomeIcon icon={faClone} />
                    </button>
                    <button
                      type="button"
                      className="migration-modal-icon-button"
                      title="Paste target folder"
                      onClick={() => void pasteTarget(index)}
                      disabled={rowDisabled}
                    >
                      <FontAwesomeIcon icon={faPaste} />
                    </button>
                    <button
                      type="button"
                      className="migration-modal-icon-button is-danger"
                      title="Delete legacy project from disk"
                      onClick={() => void deleteRow(index)}
                      disabled={busy || row.status === "running"}
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  </div>
                  <div className="migration-modal-cell migration-modal-cell-status">
                    {row.status === "running" ? <span className="migration-modal-status">Migrating…</span> : null}
                    {row.status === "succeeded" ? (
                      <span className="migration-modal-status is-succeeded">
                        <FontAwesomeIcon icon={faCheck} /> Migrated
                      </span>
                    ) : null}
                    {row.status === "failed" ? (
                      <span className="migration-modal-status is-failed" title={row.errorMessage}>
                        <FontAwesomeIcon icon={faTriangleExclamation} /> Failed
                      </span>
                    ) : null}
                    {row.status === "pending" && row.errorMessage ? (
                      <span className="migration-modal-status is-failed" title={row.errorMessage}>
                        <FontAwesomeIcon icon={faTriangleExclamation} /> {row.errorMessage}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <footer>
          <div className="migration-modal-footer-meta">
            {selectedPendingCount > 0
              ? `${selectedPendingCount} selected`
              : selectedWithoutTargetCount > 0
                ? `${selectedWithoutTargetCount} selected, missing target folder`
                : "Select rows to migrate."}
          </div>
          <div className="migration-modal-footer-actions">
            <button
              type="button"
              className="migration-modal-button"
              onClick={() => void migrateSelected()}
              disabled={busy || selectedPendingCount === 0}
            >
              <FontAwesomeIcon icon={faAnglesRight} /> Migrate Selected
            </button>
            <button
              type="button"
              className="migration-modal-button"
              onClick={() => void closeModal()}
              disabled={busy}
            >
              <FontAwesomeIcon icon={faXmark} /> Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

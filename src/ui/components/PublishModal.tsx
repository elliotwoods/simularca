import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faLink, faTrash } from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { BUILD_INFO } from "@/app/buildInfo";
import {
  cancelPublish,
  checkViewerVersion,
  deletePublish,
  deployViewerToVercel,
  loadPublishSettings,
  openExternalUrl,
  setDefaultPublishLayout,
  setDefaultViewerPermissions,
  startPublish,
  subscribePublishProgress,
  subscribeViewerDeployProgress
} from "@/features/publish/publishClient";
import type { PublishConfig, ViewerPermissions } from "@/features/publish/publishConfigSchema";
import { defaultPublishConfig } from "@/features/publish/publishConfigSchema";
import { PublishLayoutDesigner } from "@/ui/components/PublishLayoutDesigner";
import { applyPanelToggleToLayout, reconcileLayoutWithPanels } from "@/ui/FlexLayoutHost";
import {
  captureActiveThumbnail,
  hasActiveThumbnailCapturer
} from "@/features/render/viewportThumbnailBridge";
import type { ViewportThumbnailResult } from "@/features/render/viewportScreenshot";
import type { IJsonModel } from "flexlayout-react";
import type {
  DeployViewerProgressEvent,
  ListedPublish,
  ProjectSnapshotListEntry,
  PublishCheckViewerVersionResult,
  PublishProgressEvent,
  RedactedPublishSettings,
  RedactedPublishTarget
} from "@/types/ipc";
import { PublishCredentialsModal } from "@/ui/components/PublishCredentialsModal";
import { VercelSettingsModal } from "@/ui/components/VercelSettingsModal";

interface PublishModalProps {
  open: boolean;
  onClose: () => void;
}

type ProgressPhase = PublishProgressEvent["phase"] | DeployViewerProgressEvent["phase"];

interface ProgressState {
  /** Distinguishes the deploy half of the flow from the R2 publish half so
   * `phaseLabel` and label switches can disambiguate `done` / `error`
   * (which exist in both vocabularies). */
  kind: "publish" | "deploy";
  phase: ProgressPhase;
  overallProgress?: number;
  message?: string;
  currentItem?: string;
  error?: string;
}

function panelKeys(): Array<{ key: keyof PublishConfig["panels"]; label: string; help: string }> {
  return [
    { key: "sceneTree", label: "Scene tree", help: "Left panel listing actors." },
    { key: "inspector", label: "Inspector", help: "Right panel showing actor parameters." },
    { key: "console", label: "Console", help: "Bottom log/console pane." },
    { key: "snapshotPicker", label: "Snapshot picker", help: "Title-bar dropdown to switch between included snapshots." }
  ];
}

function interactionKeys(): Array<{
  key: keyof PublishConfig["interactions"];
  label: string;
  help: string;
}> {
  return [
    { key: "transformGizmo", label: "Transform gizmo", help: "Editing widget — keep off for view-only." },
    { key: "axisWidget", label: "Axis widget", help: "Corner XYZ navigation gizmo." },
    { key: "viewPresets", label: "View presets", help: "Top / Front / Side / Iso shortcuts." },
    { key: "postProcessing", label: "Post-processing", help: "Bloom, vignette, etc." },
    { key: "orbitPanZoom", label: "Orbit / pan / zoom", help: "Mouse navigation. Disable to lock the camera." }
  ];
}

function permissionKeys(): Array<{
  key: keyof PublishConfig["permissions"];
  label: string;
  help: string;
}> {
  return [
    { key: "canEditParameters", label: "Edit parameters", help: "Allow viewers to change actor parameters in the Inspector. Changes are local — never uploaded." },
    { key: "canToggleVisibility", label: "Toggle visibility", help: "Allow viewers to hide/show actors from the Scene Graph." },
    { key: "canCreateActors", label: "Create new actors", help: "Allow viewers to add new actors via the Add Actor menu." },
    { key: "canDeleteActors", label: "Delete actors", help: "Allow viewers to delete selected actors." },
    { key: "canTransformActors", label: "Move / rotate / scale", help: "Allow viewers to edit actor transforms (position, rotation, scale)." }
  ];
}

function toolbarSectionKeys(): Array<{
  key: keyof PublishConfig["header"]["toolbar"];
  label: string;
  help: string;
  /** When set, the section requires this viewer permission to take effect. */
  requiresPermission?: keyof PublishConfig["permissions"];
}> {
  return [
    { key: "camera", label: "Camera presets", help: "View preset dropdown (top / front / iso / etc.)." },
    { key: "time", label: "Time controls", help: "Play / pause / step / timecode for time-based scenes." },
    { key: "fps", label: "FPS readout", help: "Frame rate value + sparkline." },
    {
      key: "edit",
      label: "Undo / redo",
      help: "Edit history buttons. Only effective when the 'Edit parameters' viewer permission is granted.",
      requiresPermission: "canEditParameters"
    },
    {
      key: "materials",
      label: "Materials palette",
      help: "Material library button. Only effective when the 'Edit parameters' viewer permission is granted.",
      requiresPermission: "canEditParameters"
    },
    { key: "keyboard", label: "Keyboard map", help: "Button to open the keyboard shortcut overlay." }
  ];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const deltaMs = Date.now() - parsed;
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `${String(sec)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${String(hr)}h ago`;
  const day = Math.round(hr / 24);
  return `${String(day)}d ago`;
}

function bytesForPublish(entry: ListedPublish): number {
  let total = 0;
  for (const blob of entry.referencedBlobs) total += blob.byteSize;
  return total;
}

function bytesForTarget(settings: RedactedPublishSettings | null, targetId: string | null): number {
  if (!settings || !targetId) return 0;
  const seen = new Map<string, number>();
  for (const list of Object.values(settings.publishesByProjectUuid)) {
    for (const entry of list) {
      if (entry.targetId !== targetId) continue;
      for (const blob of entry.referencedBlobs) {
        seen.set(blob.key, blob.byteSize);
      }
    }
  }
  let total = 0;
  for (const size of seen.values()) total += size;
  return total;
}

function listAllPublishesForTarget(
  settings: RedactedPublishSettings | null,
  targetId: string | null
): ListedPublish[] {
  if (!settings || !targetId) return [];
  const all: ListedPublish[] = [];
  for (const list of Object.values(settings.publishesByProjectUuid)) {
    for (const entry of list) {
      if (entry.targetId === targetId) all.push(entry);
    }
  }
  return all.sort((a, b) => Date.parse(b.lastPublishedAtIso) - Date.parse(a.lastPublishedAtIso));
}

export function PublishModal(props: PublishModalProps) {
  const kernel = useKernel();
  const activeProject = useAppStore((store) => store.state.activeProject);
  const activeSnapshotName = useAppStore((store) => store.state.activeSnapshotName);

  const [settings, setSettings] = useState<RedactedPublishSettings | null>(null);
  const [snapshots, setSnapshots] = useState<ProjectSnapshotListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  useEffect(() => {
    if (!statusToast) return;
    const timer = setTimeout(() => setStatusToast(null), 8000);
    return () => clearTimeout(timer);
  }, [statusToast]);

  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectedSnapshotNames, setSelectedSnapshotNames] = useState<string[]>([]);
  const [defaultSnapshotName, setDefaultSnapshotName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  // Multi-selection in the sidebar (drives bulk delete + the re-publish form
  // when exactly one is selected). Plain click replaces, Ctrl/Cmd toggles,
  // Shift extends from the anchor.
  const [selectedPublishIds, setSelectedPublishIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [viewerConfig, setViewerConfig] = useState<PublishConfig>(() => defaultPublishConfig());

  // The form's "re-publish over this entry" target is the unique selection,
  // if any. Multi-selection means no specific re-publish target.
  const reusePublishId = selectedPublishIds.size === 1 ? Array.from(selectedPublishIds)[0]! : null;

  const [versionCheck, setVersionCheck] = useState<PublishCheckViewerVersionResult | null>(null);
  const [versionChecking, setVersionChecking] = useState(false);
  /**
   * Mutually-exclusive strategy chosen by the user when the editor sha
   * isn't deployed. Selected via radios in ViewerSection; the actual
   * deploy/override/pin happens when the user clicks Publish.
   *  - "deploy": run the Vercel deploy first, then publish (recommended
   *      when Vercel is connected).
   *  - "use-last": pin requiredViewerSha to the last successfully-deployed
   *      sha for this Vercel project.
   *  - "override": publish anyway; the URL 404s until a viewer for the
   *      pinned sha is hosted.
   *  - null: no strategy needed (viewer IS deployed at the editor sha).
   */
  type ViewerStrategy = "deploy" | "use-last" | "override";
  const [viewerStrategy, setViewerStrategy] = useState<ViewerStrategy | null>(null);

  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [vercelSettingsOpen, setVercelSettingsOpen] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ viewerUrl: string } | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const [viewerDeployJobId, setViewerDeployJobId] = useState<string | null>(null);
  const viewerDeployJobIdRef = useRef<string | null>(null);
  const [thumbnail, setThumbnail] = useState<ViewportThumbnailResult | null>(null);
  const [thumbnailCapturing, setThumbnailCapturing] = useState(false);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const thumbnailPreviewUrl = useMemo(() => {
    if (!thumbnail) return null;
    // Cast through BlobPart — the runtime Uint8Array works fine; the strict
    // TS check rejects it because `.buffer` could in theory be a
    // SharedArrayBuffer, which it isn't here.
    const blob = new Blob([thumbnail.jpegBytes as BlobPart], { type: thumbnail.contentType });
    return URL.createObjectURL(blob);
  }, [thumbnail]);
  useEffect(() => {
    return () => {
      if (thumbnailPreviewUrl) URL.revokeObjectURL(thumbnailPreviewUrl);
    };
  }, [thumbnailPreviewUrl]);

  const captureThumbnail = useCallback(async (): Promise<void> => {
    if (!hasActiveThumbnailCapturer()) {
      setThumbnailError("Viewport isn't ready — open or focus a project first.");
      return;
    }
    setThumbnailCapturing(true);
    setThumbnailError(null);
    try {
      const result = await captureActiveThumbnail();
      setThumbnail(result);
    } catch (reason) {
      setThumbnailError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setThumbnailCapturing(false);
    }
  }, []);
  useEffect(() => {
    viewerDeployJobIdRef.current = viewerDeployJobId;
  }, [viewerDeployJobId]);

  useEffect(() => {
    activeJobIdRef.current = activeJobId;
  }, [activeJobId]);

  const reload = useCallback(
    async (forceFresh = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const loadedSettings = await loadPublishSettings();
        setSettings(loadedSettings);
        if (forceFresh) {
          // Modal just opened: seed the in-flight publish config from the
          // publisher's saved defaults. Subsequent reloads (e.g. after a
          // delete) leave the user's in-flight edits alone.
          setViewerConfig((current) => {
            const next: PublishConfig = { ...current };
            if (loadedSettings.defaultPublishLayout) {
              // Reconcile the saved layout against the current panel flags
              // so the layout designer opens consistent with the checkboxes
              // (defaults may have shifted since the layout was saved).
              const savedLayout = loadedSettings.defaultPublishLayout;
              next.layout =
                savedLayout && typeof savedLayout === "object"
                  ? reconcileLayoutWithPanels(savedLayout as IJsonModel, next.panels)
                  : savedLayout;
            }
            const savedPermissions = loadedSettings.defaultViewerPermissions as
              | Partial<ViewerPermissions>
              | undefined;
            if (savedPermissions && typeof savedPermissions === "object") {
              next.permissions = { ...current.permissions, ...savedPermissions };
            }
            return next;
          });
        }
        if (forceFresh || !selectedTargetId || !loadedSettings.targets.some((t) => t.id === selectedTargetId)) {
          setSelectedTargetId(
            loadedSettings.defaultTargetId ?? loadedSettings.targets[0]?.id ?? null
          );
        }
        if (activeProject) {
          const loadedSnapshots = await kernel.storage.listSnapshots(activeProject.path);
          setSnapshots(loadedSnapshots);
          setTitle((current) => current || activeProject.name);
          setSelectedSnapshotNames((current) => {
            if (current.length > 0) {
              const filtered = current.filter((name) => loadedSnapshots.some((s) => s.name === name));
              if (filtered.length > 0) return filtered;
            }
            const initial = activeSnapshotName && loadedSnapshots.some((s) => s.name === activeSnapshotName)
              ? [activeSnapshotName]
              : loadedSnapshots[0]
                ? [loadedSnapshots[0].name]
                : [];
            return initial;
          });
          setDefaultSnapshotName((current) => current ?? activeSnapshotName ?? loadedSnapshots[0]?.name ?? null);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [activeProject, activeSnapshotName, kernel.storage, selectedTargetId]
  );

  useEffect(() => {
    if (!props.open) return;
    setProgress(null);
    setDoneInfo(null);
    setActiveJobId(null);
    setViewerStrategy(null);
    // Auto-capture a thumbnail from the live viewport so the publisher
    // sees what their social card will look like the moment the modal
    // opens. Errors are non-fatal (e.g. no project loaded yet) — publisher
    // can Retake later or Skip.
    setThumbnail(null);
    setThumbnailError(null);
    void captureThumbnail();
    void reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !window.electronAPI) return;
    return subscribeViewerDeployProgress((event) => {
      if (event.jobId !== viewerDeployJobIdRef.current) return;
      // Drive a unified progress bar across deploy + publish. While the
      // deploy is uploading files, derive 0..1 from uploadedFiles/totalFiles
      // so the bar moves visibly. The terminal "done" of the deploy stays at
      // 1 until the publish kicks in and resets to its own preflight=0.
      const fileFraction =
        event.totalFiles && event.totalFiles > 0 && event.uploadedFiles !== undefined
          ? event.uploadedFiles / event.totalFiles
          : undefined;
      setProgress({
        kind: "deploy",
        phase: event.phase,
        overallProgress: fileFraction,
        message: event.message,
        currentItem:
          event.uploadedFiles !== undefined && event.totalFiles
            ? `${String(event.uploadedFiles)}/${String(event.totalFiles)} files`
            : undefined,
        error: event.error
      });
      if (event.phase === "done" || event.phase === "ready") {
        setViewerDeployJobId(null);
        void (async () => {
          // The deploy we just ran is the source of truth — trust it. The
          // production-alias swap on Vercel can lag the deploy "ready"
          // signal by 5–30s, during which a HEAD against the production URL
          // returns 404 and would incorrectly send us back to the "needs
          // deploy" state. Optimistically mark the pre-flight as passed,
          // refresh saved settings so `lastDeployedSha` reflects this sha,
          // continue into publish if the user chained one, and only then
          // run a confirmation check (with retries) in the background.
          setVersionCheck({ deployed: true, status: 200 });
          await reload();
          if (pendingPublishAfterDeployRef.current) {
            pendingPublishAfterDeployRef.current = false;
            await runPublishStartIpc();
          }
          void runVersionCheck({ maxRetries: 10, retryDelayMs: 3000 });
        })();
      }
      if (event.phase === "error") {
        console.error("[publish] viewer deploy failed:", event.error, event);
        setViewerDeployJobId(null);
        pendingPublishAfterDeployRef.current = false;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !window.electronAPI) return;
    return subscribePublishProgress((event) => {
      if (event.jobId !== activeJobIdRef.current) return;
      setProgress({
        kind: "publish",
        phase: event.phase,
        overallProgress: event.overallProgress,
        message: event.message,
        currentItem: event.currentItem,
        error: event.error
      });
      if (event.phase === "done" && event.viewerUrl) {
        setDoneInfo({ viewerUrl: event.viewerUrl });
        setActiveJobId(null);
        // Refresh sidebar so the new entry shows up.
        void reload();
      }
      if (event.phase === "error") {
        console.error("[publish] publish failed:", event.error, event);
        setActiveJobId(null);
      }
    });
  }, [props.open, reload]);

  const selectedTarget: RedactedPublishTarget | null = useMemo(() => {
    if (!settings || !selectedTargetId) return null;
    return settings.targets.find((t) => t.id === selectedTargetId) ?? null;
  }, [settings, selectedTargetId]);

  const lastDeployedSha = settings?.viewerDeployment?.lastDeployedSha ?? null;
  const hasVercelToken = Boolean(settings?.viewerDeployment?.hasVercelToken);
  const currentEditorSha = BUILD_INFO.commitShortSha;
  const requiredViewerShaOverride =
    viewerStrategy === "use-last" && lastDeployedSha ? lastDeployedSha : null;
  const effectiveViewerSha = requiredViewerShaOverride ?? currentEditorSha;

  // Treat a local "we already deployed this sha" record as authoritative for
  // gating purposes. The HEAD check against the production URL can lag for
  // 5–30s after Vercel's "ready" signal (alias swap / CDN), so we must not
  // fall back to "needs deploy" while our own records say we just did it.
  const locallyKnownDeployed =
    lastDeployedSha !== null && lastDeployedSha === effectiveViewerSha;

  // Auto-pick a strategy when the editor sha isn't deployed and the user
  // hasn't already chosen one. Cleared whenever the deploy succeeds.
  useEffect(() => {
    if (!versionCheck) return;
    if (versionCheck.deployed || locallyKnownDeployed) {
      // Pre-flight passed (or we just deployed locally) — no strategy needed.
      if (viewerStrategy !== null) setViewerStrategy(null);
      return;
    }
    if (viewerStrategy !== null) return;
    if (hasVercelToken) setViewerStrategy("deploy");
    else if (lastDeployedSha) setViewerStrategy("use-last");
    else setViewerStrategy("override");
  }, [versionCheck, viewerStrategy, hasVercelToken, lastDeployedSha, locallyKnownDeployed]);

  const runVersionCheck = useCallback(async (options: { maxRetries?: number; retryDelayMs?: number } = {}) => {
    if (!selectedTargetId) {
      setVersionCheck(null);
      return;
    }
    setVersionChecking(true);
    try {
      const result = await checkViewerVersion({
        targetId: selectedTargetId,
        sha: effectiveViewerSha,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs
      });
      setVersionCheck(result);
    } catch (reason) {
      setVersionCheck({ deployed: false, error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setVersionChecking(false);
    }
  }, [effectiveViewerSha, selectedTargetId]);

  useEffect(() => {
    if (!props.open) return;
    void runVersionCheck();
  }, [props.open, runVersionCheck]);

  const handleToggleSnapshot = (name: string): void => {
    setSelectedSnapshotNames((prev) => {
      if (prev.includes(name)) {
        const next = prev.filter((entry) => entry !== name);
        if (defaultSnapshotName === name) setDefaultSnapshotName(next[0] ?? null);
        return next;
      }
      return [...prev, name];
    });
  };

  const handleSelectPublishInSidebar = (
    entry: ListedPublish,
    modifiers: { ctrl: boolean; shift: boolean }
  ): void => {
    const visibleIds = sidebarPublishesRef.current.map((e) => e.publishId);
    setSelectedPublishIds((prev) => {
      const next = new Set(prev);
      if (modifiers.shift && selectionAnchorId) {
        // Range from anchor to entry inclusive (additive — doesn't clear).
        const a = visibleIds.indexOf(selectionAnchorId);
        const b = visibleIds.indexOf(entry.publishId);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i += 1) next.add(visibleIds[i]!);
        } else {
          next.add(entry.publishId);
        }
      } else if (modifiers.ctrl) {
        if (next.has(entry.publishId)) next.delete(entry.publishId);
        else next.add(entry.publishId);
      } else {
        next.clear();
        next.add(entry.publishId);
      }
      return next;
    });
    if (!modifiers.shift) {
      setSelectionAnchorId(entry.publishId);
    }
    // When the user single-selects (or after a single-add), pre-fill the
    // form with that publish's title/target. We base this on the post-update
    // selection, but since setState is async we infer it: a plain click
    // always selects exactly that entry; ctrl/shift may produce multiple.
    if (!modifiers.ctrl && !modifiers.shift) {
      setTitle(entry.title);
      setSelectedTargetId(entry.targetId);
      // Defer to the strategy auto-picker for the viewer-pin choice.
      setViewerStrategy(null);
    }
  };

  const handleDeletePublish = async (entry: ListedPublish): Promise<void> => {
    const blobs = entry.referencedBlobs ?? [];
    const sharedKeys = new Set(
      blobs.filter((b) => b.kind === "asset" || b.kind === "plugin").map((b) => b.key)
    );
    // Walk other publishes on the same target to estimate how many shared
    // blobs the delete would actually free.
    const stillReferenced = new Set<string>();
    if (settings) {
      for (const list of Object.values(settings.publishesByProjectUuid)) {
        for (const other of list) {
          if (other.publishId === entry.publishId) continue;
          if (other.targetId !== entry.targetId) continue;
          for (const b of other.referencedBlobs) stillReferenced.add(b.key);
        }
      }
    }
    let estFreedBytes = 0;
    let estFreedShared = 0;
    let estRetainedShared = 0;
    for (const b of blobs) {
      if (b.kind === "manifest" || b.kind === "snapshot" || b.kind === "config" || b.kind === "latest") {
        estFreedBytes += b.byteSize;
      } else if (sharedKeys.has(b.key) && !stillReferenced.has(b.key)) {
        estFreedBytes += b.byteSize;
        estFreedShared += 1;
      } else if (sharedKeys.has(b.key) && stillReferenced.has(b.key)) {
        estRetainedShared += 1;
      }
    }
    const msgParts = [`Delete publish "${entry.title}"?`];
    msgParts.push(``);
    msgParts.push(`This will free ~${formatBytes(estFreedBytes)} from R2.`);
    if (estFreedShared > 0) {
      msgParts.push(`${String(estFreedShared)} content-addressed file(s) will be purged (not referenced by any other publish).`);
    }
    if (estRetainedShared > 0) {
      msgParts.push(`${String(estRetainedShared)} file(s) will be kept — other publish(es) still reference them.`);
    }
    msgParts.push(``);
    msgParts.push(`The viewer URL stops resolving immediately.`);
    // eslint-disable-next-line no-alert
    if (!window.confirm(msgParts.join("\n"))) {
      return;
    }
    try {
      const result = await deletePublish({ targetId: entry.targetId, publishId: entry.publishId });
      // The IPC handler returns a structured result, but to stay robust
      // against an Electron main process still running an older compiled
      // build whose handler returned the redacted settings directly, we
      // always re-fetch from disk afterward rather than trusting the
      // returned shape.
      const fresh = await loadPublishSettings();
      setSettings(fresh);
      // Drop the deleted entry from any selection state.
      setSelectedPublishIds((prev) => {
        if (!prev.has(entry.publishId)) return prev;
        const next = new Set(prev);
        next.delete(entry.publishId);
        return next;
      });
      if (selectionAnchorId === entry.publishId) setSelectionAnchorId(null);
      const summary: string[] = [`Deleted "${entry.title}".`];
      // `result` may be the new PublishDeleteResult shape or, after an
      // edge case where the user's Electron is mid-restart, undefined-ish.
      // Skip the size/count summary if those fields are absent.
      if (result && typeof result === "object" && "bytesFreed" in result) {
        const r = result as {
          bytesFreed?: number;
          deletedBlobCount?: number;
          deletedSharedCount?: number;
          retainedSharedCount?: number;
          failedKeyCount?: number;
        };
        if (typeof r.bytesFreed === "number" && typeof r.deletedBlobCount === "number") {
          summary.push(`Freed ${formatBytes(r.bytesFreed)} across ${String(r.deletedBlobCount)} object(s).`);
        }
        if (typeof r.deletedSharedCount === "number" && r.deletedSharedCount > 0) {
          summary.push(`Purged ${String(r.deletedSharedCount)} orphaned shared file(s).`);
        }
        if (typeof r.retainedSharedCount === "number" && r.retainedSharedCount > 0) {
          summary.push(`Kept ${String(r.retainedSharedCount)} shared file(s) still in use.`);
        }
        if (typeof r.failedKeyCount === "number" && r.failedKeyCount > 0) {
          summary.push(`${String(r.failedKeyCount)} object(s) failed to delete — check console.`);
        }
      }
      setStatusToast(summary.join(" "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleBulkDelete = async (): Promise<void> => {
    const ids = Array.from(selectedPublishIds);
    const entries = ids
      .map((id) => sidebarPublishesRef.current.find((e) => e.publishId === id))
      .filter((entry): entry is ListedPublish => Boolean(entry));
    if (entries.length === 0) return;
    // Estimate freed bytes by walking the same logic the IPC handler will use.
    const targetIds = new Set(entries.map((e) => e.targetId));
    const stillReferencedAfter = new Set<string>();
    if (settings) {
      const deletedIds = new Set(entries.map((e) => e.publishId));
      for (const list of Object.values(settings.publishesByProjectUuid)) {
        for (const other of list) {
          if (deletedIds.has(other.publishId)) continue;
          if (!targetIds.has(other.targetId)) continue;
          for (const b of other.referencedBlobs) stillReferencedAfter.add(b.key);
        }
      }
    }
    let freedBytes = 0;
    for (const entry of entries) {
      for (const b of entry.referencedBlobs) {
        const isPerPublish =
          b.kind === "manifest" || b.kind === "snapshot" || b.kind === "config" || b.kind === "latest";
        const sharedPurgeable =
          (b.kind === "asset" || b.kind === "plugin") && !stillReferencedAfter.has(b.key);
        if (isPerPublish || sharedPurgeable) freedBytes += b.byteSize;
      }
    }
    const titles = entries
      .slice(0, 4)
      .map((e) => `  · ${e.title || e.publishId}`)
      .join("\n");
    const more = entries.length > 4 ? `\n  · …and ${String(entries.length - 4)} more` : "";
    const msg = [
      `Delete ${String(entries.length)} publishes?`,
      "",
      titles + more,
      "",
      `This will free ~${formatBytes(freedBytes)} from R2.`,
      "Each viewer URL stops resolving immediately."
    ].join("\n");
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return;

    let succeeded = 0;
    let failed = 0;
    let totalFreed = 0;
    for (const entry of entries) {
      try {
        const result = await deletePublish({ targetId: entry.targetId, publishId: entry.publishId });
        if (result && typeof result === "object" && "bytesFreed" in result) {
          const r = result as { bytesFreed?: number };
          if (typeof r.bytesFreed === "number") totalFreed += r.bytesFreed;
        }
        succeeded += 1;
      } catch (reason) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error("[publish] bulk delete failed for", entry.publishId, reason);
      }
    }
    const fresh = await loadPublishSettings();
    setSettings(fresh);
    setSelectedPublishIds(new Set());
    setSelectionAnchorId(null);
    const summary = [`Deleted ${String(succeeded)} publishes.`, `Freed ${formatBytes(totalFreed)} from R2.`];
    if (failed > 0) summary.push(`${String(failed)} failed — see console.`);
    setStatusToast(summary.join(" "));
  };

  const orderedSnapshotNames = useMemo(() => {
    if (!defaultSnapshotName) return selectedSnapshotNames;
    const head = selectedSnapshotNames.filter((name) => name === defaultSnapshotName);
    const rest = selectedSnapshotNames.filter((name) => name !== defaultSnapshotName);
    return [...head, ...rest];
  }, [defaultSnapshotName, selectedSnapshotNames]);

  const lastDeployedAlsoCurrent = lastDeployedSha === BUILD_INFO.commitShortSha;
  // Either pre-flight passed naturally, or the user picked a strategy that
  // makes publishing OK (deploy first, fall back to last-deployed sha, or
  // accept the URL will 404 until a viewer ships).
  const versionGatePassed =
    versionCheck?.deployed === true ||
    locallyKnownDeployed ||
    viewerStrategy === "deploy" ||
    viewerStrategy === "use-last" ||
    viewerStrategy === "override";

  const canPublish = Boolean(
    selectedTargetId &&
      orderedSnapshotNames.length > 0 &&
      title.trim().length > 0 &&
      versionGatePassed &&
      !activeJobId &&
      !loading
  );

  // True while we're waiting on a deploy that should be followed by an
  // automatic publish (the user picked the "deploy first" strategy).
  const pendingPublishAfterDeployRef = useRef(false);

  const runPublishStartIpc = useCallback(async (): Promise<void> => {
    if (!selectedTargetId || !activeProject) return;
    setProgress({ kind: "publish", phase: "preflight", overallProgress: 0 });
    setDoneInfo(null);
    try {
      const ack = await startPublish({
        projectPath: activeProject.path,
        snapshotNames: orderedSnapshotNames,
        title: title.trim(),
        viewerConfig,
        targetId: selectedTargetId,
        publishId: reusePublishId ?? undefined,
        requiredViewerShaOverride: requiredViewerShaOverride ?? undefined,
        thumbnail: thumbnail
          ? {
              bytes: thumbnail.jpegBytes,
              width: thumbnail.width,
              height: thumbnail.height,
              contentType: thumbnail.contentType
            }
          : undefined
      });
      setActiveJobId(ack.jobId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error("[publish] failed to start publish:", reason);
      setProgress({ kind: "publish", phase: "error", error: message });
      setActiveJobId(null);
    }
  }, [
    activeProject,
    orderedSnapshotNames,
    requiredViewerShaOverride,
    reusePublishId,
    selectedTargetId,
    thumbnail,
    title,
    viewerConfig
  ]);

  const handlePublish = async (): Promise<void> => {
    if (!selectedTargetId || !canPublish || !activeProject) return;

    // Strategy "deploy" → run the Vercel deploy first, then publish. The
    // deploy is async via IPC; we set a flag so the deploy "done" handler
    // continues into the publish step automatically. Skip if we already
    // deployed this sha locally (CDN/alias lag would otherwise force a
    // redundant deploy every time).
    const needsDeployFirst =
      versionCheck?.deployed !== true &&
      !locallyKnownDeployed &&
      viewerStrategy === "deploy";
    if (needsDeployFirst) {
      if (!hasVercelToken) {
        setError(
          "Cannot deploy viewer: Vercel not connected. Pick a different option or open Vercel settings."
        );
        return;
      }
      pendingPublishAfterDeployRef.current = true;
      setProgress({ kind: "deploy", phase: "build", message: "Starting build…" });
      try {
        const ack = await deployViewerToVercel();
        setViewerDeployJobId(ack.jobId);
      } catch (reason) {
        pendingPublishAfterDeployRef.current = false;
        const message = reason instanceof Error ? reason.message : String(reason);
        console.error("[publish] failed to start viewer deploy:", reason);
        setProgress({ kind: "deploy", phase: "error", error: message });
        setViewerDeployJobId(null);
      }
      return;
    }

    await runPublishStartIpc();
  };

  const handleCancel = async (): Promise<void> => {
    if (!activeJobId) return;
    await cancelPublish(activeJobId);
  };

  const sidebarPublishes = useMemo(
    () => listAllPublishesForTarget(settings, selectedTargetId),
    [settings, selectedTargetId]
  );
  const sidebarTotalBytes = useMemo(
    () => bytesForTarget(settings, selectedTargetId),
    [settings, selectedTargetId]
  );

  // Mirror the visible publishes list into a ref so the click handler's
  // shift-range computation can read the order synchronously without being
  // re-created on every list change.
  const sidebarPublishesRef = useRef<ListedPublish[]>([]);
  useEffect(() => {
    sidebarPublishesRef.current = sidebarPublishes;
  }, [sidebarPublishes]);

  if (!props.open) return null;

  return (
    <>
      <div
        className="modal-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget && !activeJobId && !viewerDeployJobId) props.onClose();
        }}
      >
        <div className="publish-modal" role="dialog" aria-modal="true" aria-label="Publish to web">
          <header>
            <h3>Publish to web</h3>
            <button
              type="button"
              className="modal-close"
              onClick={props.onClose}
              disabled={Boolean(activeJobId)}
              aria-label="Close"
            >
              ×
            </button>
          </header>
          {loading && !settings ? (
            <div className="publish-modal-loading">Loading publish settings…</div>
          ) : !settings || settings.targets.length === 0 ? (
            <div className="publish-modal-empty">
              <p>No publish targets configured.</p>
              <button type="button" className="primary" onClick={() => setCredentialsOpen(true)}>
                Configure a target…
              </button>
            </div>
          ) : (
            <div className="publish-modal-body">
              <aside className="publish-modal-sidebar">
                <PublishSidebar
                  selectedTargetId={selectedTargetId}
                  settings={settings}
                  publishes={sidebarPublishes}
                  totalBytes={sidebarTotalBytes}
                  selectedPublishIds={selectedPublishIds}
                  onSelectTarget={(id) => {
                    setSelectedTargetId(id);
                    setSelectedPublishIds(new Set());
                    setSelectionAnchorId(null);
                  }}
                  onSelectPublish={handleSelectPublishInSidebar}
                  onDeletePublish={(entry) => {
                    void handleDeletePublish(entry);
                  }}
                  onOpenPublish={(entry) => {
                    if (entry.viewerUrl) {
                      void openExternalUrl(entry.viewerUrl);
                    }
                  }}
                  onCopyPublishUrl={(entry) => {
                    if (!entry.viewerUrl) return;
                    void navigator.clipboard.writeText(entry.viewerUrl).then(
                      () => setStatusToast(`Copied "${entry.title}" URL to clipboard.`),
                      (reason) => setError(reason instanceof Error ? reason.message : String(reason))
                    );
                  }}
                  onNewPublish={() => {
                    setSelectedPublishIds(new Set());
                    setSelectionAnchorId(null);
                    setTitle(activeProject?.name ?? "");
                    setViewerStrategy(null);
                  }}
                  onManageTargets={() => setCredentialsOpen(true)}
                />
              </aside>

              <div className="publish-modal-main">
                <PublishSection title="Storage">
                  {selectedTarget ? (
                    <div className="publish-section-row">
                      <div className="publish-section-kv">
                        <span className="publish-kv-key">Bucket</span>
                        <code>{selectedTarget.r2.bucket}</code>
                      </div>
                      <div className="publish-section-kv">
                        <span className="publish-kv-key">Public URL</span>
                        <code>{selectedTarget.bucketBaseUrl}</code>
                      </div>
                      <button
                        type="button"
                        className="link"
                        onClick={() => setCredentialsOpen(true)}
                        disabled={Boolean(activeJobId)}
                      >
                        Manage credentials…
                      </button>
                    </div>
                  ) : null}
                </PublishSection>

                <PublishSection title="Viewer">
                  {selectedTarget ? (
                    <ViewerSection
                      viewerUrl={selectedTarget.viewerUrl}
                      versionCheck={versionCheck}
                      versionChecking={versionChecking}
                      effectiveSha={effectiveViewerSha}
                      currentEditorSha={currentEditorSha}
                      lastDeployedSha={lastDeployedSha}
                      lastDeployedAlsoCurrent={lastDeployedAlsoCurrent}
                      hasVercelToken={hasVercelToken}
                      accountLabel={settings.viewerDeployment?.cachedAccountLabel}
                      deployJobId={viewerDeployJobId}
                      activeJobId={activeJobId}
                      strategy={viewerStrategy}
                      onChangeStrategy={setViewerStrategy}
                      onRunVersionCheck={() => void runVersionCheck()}
                      onOpenVercelSettings={() => setVercelSettingsOpen(true)}
                    />
                  ) : null}
                </PublishSection>

                <PublishSection title="Snapshots">
                  <p className="publish-modal-hint">
                    Pick which snapshots ship with this publish. The first one becomes the viewer's default.
                  </p>
                  <div className="publish-modal-snapshot-list">
                    {snapshots.map((snapshot) => {
                      const checked = selectedSnapshotNames.includes(snapshot.name);
                      const isDefault = checked && defaultSnapshotName === snapshot.name;
                      return (
                        <div key={snapshot.name} className="publish-modal-snapshot-row">
                          <label>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleToggleSnapshot(snapshot.name)}
                              disabled={Boolean(activeJobId)}
                            />
                            <span>{snapshot.name}</span>
                          </label>
                          {checked && selectedSnapshotNames.length > 1 ? (
                            <label className="publish-modal-default-snapshot">
                              <input
                                type="radio"
                                name="default-snapshot"
                                checked={isDefault}
                                onChange={() => setDefaultSnapshotName(snapshot.name)}
                                disabled={Boolean(activeJobId)}
                              />
                              <span>default</span>
                            </label>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </PublishSection>

                <PublishSection title="Title & viewer features">
                  <label className="publish-modal-title-input">
                    <span className="publish-kv-key">Title</span>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Display name for the published viewer"
                      disabled={Boolean(activeJobId)}
                    />
                  </label>
                  <div className="publish-modal-toggle-grid">
                    <fieldset>
                      <legend>Panels</legend>
                      {panelKeys().map((entry) => (
                        <label key={entry.key} title={entry.help}>
                          <input
                            type="checkbox"
                            checked={viewerConfig.panels[entry.key]}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              const nextPanels = {
                                ...viewerConfig.panels,
                                [entry.key]: enabled
                              };
                              // If the publisher has already customised the
                              // layout, surgically add/remove the toggled
                              // panel's tab so the layout designer stays in
                              // sync. With no custom layout, the designer
                              // re-derives from `panels` on its own.
                              const nextLayout =
                                viewerConfig.layout && typeof viewerConfig.layout === "object"
                                  ? applyPanelToggleToLayout(
                                      viewerConfig.layout as IJsonModel,
                                      entry.key,
                                      enabled
                                    )
                                  : viewerConfig.layout;
                              setViewerConfig({
                                ...viewerConfig,
                                panels: nextPanels,
                                layout: nextLayout
                              });
                            }}
                            disabled={Boolean(activeJobId)}
                          />
                          <span>{entry.label}</span>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Interactions</legend>
                      {interactionKeys().map((entry) => (
                        <label key={entry.key} title={entry.help}>
                          <input
                            type="checkbox"
                            checked={viewerConfig.interactions[entry.key]}
                            onChange={(e) =>
                              setViewerConfig({
                                ...viewerConfig,
                                interactions: {
                                  ...viewerConfig.interactions,
                                  [entry.key]: e.target.checked
                                }
                              })
                            }
                            disabled={Boolean(activeJobId)}
                          />
                          <span>{entry.label}</span>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Viewer can…</legend>
                      {permissionKeys().map((entry) => (
                        <label key={entry.key} title={entry.help}>
                          <input
                            type="checkbox"
                            checked={viewerConfig.permissions[entry.key]}
                            onChange={(e) =>
                              setViewerConfig({
                                ...viewerConfig,
                                permissions: {
                                  ...viewerConfig.permissions,
                                  [entry.key]: e.target.checked
                                }
                              })
                            }
                            disabled={Boolean(activeJobId)}
                          />
                          <span>{entry.label}</span>
                        </label>
                      ))}
                    </fieldset>
                  </div>
                </PublishSection>

                <PublishSection title="Thumbnail">
                  <p className="publish-modal-section-help">
                    Captured from the viewport at 1200 × 630 (the size used by Slack, Discord, Facebook, LinkedIn, and Twitter cards). The image is uploaded with the publish and shown whenever the published URL is shared.
                  </p>
                  <div className="publish-thumbnail-row">
                    <div className="publish-thumbnail-preview">
                      {thumbnailPreviewUrl ? (
                        <img src={thumbnailPreviewUrl} alt="Publish thumbnail preview" />
                      ) : (
                        <div className="publish-thumbnail-empty">
                          {thumbnailCapturing
                            ? "Capturing…"
                            : thumbnailError
                              ? thumbnailError
                              : "No thumbnail. Click Retake to capture one."}
                        </div>
                      )}
                    </div>
                    <div className="publish-thumbnail-meta">
                      {thumbnail ? (
                        <>
                          <div>
                            {thumbnail.width} × {thumbnail.height} {thumbnail.contentType.split("/")[1]?.toUpperCase() ?? ""}
                          </div>
                          <div>{formatBytes(thumbnail.jpegBytes.byteLength)}</div>
                        </>
                      ) : null}
                      <div className="publish-thumbnail-actions">
                        <button
                          type="button"
                          onClick={() => void captureThumbnail()}
                          disabled={thumbnailCapturing || Boolean(activeJobId)}
                        >
                          {thumbnail ? "Retake" : "Capture"}
                        </button>
                        {thumbnail ? (
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setThumbnail(null);
                              setThumbnailError(null);
                            }}
                            disabled={thumbnailCapturing || Boolean(activeJobId)}
                          >
                            Skip
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </PublishSection>

                <PublishSection title="Header bar">
                  <p className="publish-modal-section-help">
                    Controls the top of the published page. The title bar shows the Simularca logo, version, snapshot picker, and project title. The toolbar is a secondary row of viewer-friendly controls.
                  </p>
                  <div className="publish-modal-toggle-grid">
                    <fieldset>
                      <legend>Title bar</legend>
                      <label title="Show the row containing the Simularca logo / version, snapshot picker, and project title.">
                        <input
                          type="checkbox"
                          checked={viewerConfig.header.showTitleBar}
                          onChange={(e) =>
                            setViewerConfig({
                              ...viewerConfig,
                              header: { ...viewerConfig.header, showTitleBar: e.target.checked }
                            })
                          }
                          disabled={Boolean(activeJobId)}
                        />
                        <span>Show title bar</span>
                      </label>
                    </fieldset>
                    <fieldset>
                      <legend>Toolbar</legend>
                      <label title="Show the secondary toolbar row.">
                        <input
                          type="checkbox"
                          checked={viewerConfig.header.showToolbar}
                          onChange={(e) =>
                            setViewerConfig({
                              ...viewerConfig,
                              header: { ...viewerConfig.header, showToolbar: e.target.checked }
                            })
                          }
                          disabled={Boolean(activeJobId)}
                        />
                        <span>Show toolbar</span>
                      </label>
                      {toolbarSectionKeys().map((entry) => {
                        const permissionMissing =
                          entry.requiresPermission !== undefined &&
                          !viewerConfig.permissions[entry.requiresPermission];
                        const disabled =
                          Boolean(activeJobId) ||
                          !viewerConfig.header.showToolbar ||
                          permissionMissing;
                        const title = permissionMissing
                          ? `${entry.help} (Requires the "${entry.requiresPermission ?? ""}" viewer permission.)`
                          : entry.help;
                        return (
                          <label key={entry.key} title={title} style={{ paddingLeft: 16, opacity: disabled ? 0.6 : 1 }}>
                            <input
                              type="checkbox"
                              checked={viewerConfig.header.toolbar[entry.key]}
                              onChange={(e) =>
                                setViewerConfig({
                                  ...viewerConfig,
                                  header: {
                                    ...viewerConfig.header,
                                    toolbar: {
                                      ...viewerConfig.header.toolbar,
                                      [entry.key]: e.target.checked
                                    }
                                  }
                                })
                              }
                              disabled={disabled}
                            />
                            <span>{entry.label}</span>
                          </label>
                        );
                      })}
                    </fieldset>
                  </div>
                </PublishSection>

                <PublishSection title="Panel layout">
                  <PublishLayoutDesigner
                    publishConfig={viewerConfig}
                    onChange={(layout) => setViewerConfig({ ...viewerConfig, layout })}
                  />
                  <div className="publish-modal-layout-actions">
                    <button
                      type="button"
                      className="link"
                      disabled={Boolean(activeJobId)}
                      onClick={() => {
                        // Reset the layout to the panel-flag derived default
                        // and the global saved default. Clearing both fields
                        // makes the viewer re-derive from `panels`.
                        setViewerConfig({ ...viewerConfig, layout: undefined });
                      }}
                    >
                      Reset to default
                    </button>
                    <button
                      type="button"
                      className="link"
                      disabled={Boolean(activeJobId)}
                      onClick={() => {
                        void (async () => {
                          try {
                            const updated = await setDefaultPublishLayout(viewerConfig.layout ?? null);
                            await setDefaultViewerPermissions(viewerConfig.permissions);
                            setSettings(updated);
                            setStatusToast("Saved current layout and permissions as default for future publishes.");
                          } catch (reason) {
                            setError(reason instanceof Error ? reason.message : String(reason));
                          }
                        })();
                      }}
                    >
                      Save as default
                    </button>
                  </div>
                </PublishSection>

                {/* Progress shown in the footer while active; surface in
                    the main column ONLY for the terminal-error state where
                    the footer goes back to idle. */}
                {progress?.phase === "error" ? <ProgressPanel progress={progress} /> : null}
                {doneInfo ? <DonePanel viewerUrl={doneInfo.viewerUrl} /> : null}
                {statusToast ? <div className="publish-modal-toast">{statusToast}</div> : null}
                {error ? <div className="publish-modal-error">{error}</div> : null}
              </div>
            </div>
          )}
          <footer>
            {(activeJobId || viewerDeployJobId) && progress ? (
              <>
                <FooterProgress progress={progress} />
                {activeJobId ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleCancel();
                    }}
                  >
                    Cancel publish
                  </button>
                ) : null}
              </>
            ) : selectedPublishIds.size >= 2 ? (
              <>
                <span className="publish-footer-selection-summary">
                  {String(selectedPublishIds.size)} publishes selected
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPublishIds(new Set());
                    setSelectionAnchorId(null);
                  }}
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  className="primary danger"
                  onClick={() => {
                    void handleBulkDelete();
                  }}
                >
                  Delete {String(selectedPublishIds.size)} publishes
                </button>
              </>
            ) : (
              <>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="primary"
                  disabled={!canPublish}
                  onClick={() => {
                    void handlePublish();
                  }}
                  title={
                    !versionGatePassed
                      ? "Pre-flight: viewer for this sha not yet released. Use the Viewer section."
                      : undefined
                  }
                >
                  {reusePublishId ? "Re-publish" : "Publish"}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
      <PublishCredentialsModal
        open={credentialsOpen}
        onClose={() => setCredentialsOpen(false)}
        initialTargetId={selectedTargetId ?? undefined}
        onSaved={(updated) => {
          setSettings(updated);
          if (!selectedTargetId || !updated.targets.some((t) => t.id === selectedTargetId)) {
            setSelectedTargetId(updated.defaultTargetId ?? updated.targets[0]?.id ?? null);
          }
        }}
      />
      <VercelSettingsModal
        open={vercelSettingsOpen}
        onClose={() => setVercelSettingsOpen(false)}
        onSaved={(updated) => {
          setSettings(updated);
          void runVersionCheck();
        }}
      />
    </>
  );
}

// --------------------------------------------------------------------------
// Subcomponents
// --------------------------------------------------------------------------

function PublishSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="publish-section">
      <header>
        <h4>{title}</h4>
      </header>
      <div className="publish-section-body">{children}</div>
    </section>
  );
}

interface PublishSidebarProps {
  selectedTargetId: string | null;
  settings: RedactedPublishSettings;
  publishes: ListedPublish[];
  totalBytes: number;
  selectedPublishIds: Set<string>;
  onSelectTarget: (targetId: string) => void;
  onSelectPublish: (entry: ListedPublish, modifiers: { ctrl: boolean; shift: boolean }) => void;
  onDeletePublish: (entry: ListedPublish) => void;
  onOpenPublish: (entry: ListedPublish) => void;
  onCopyPublishUrl: (entry: ListedPublish) => void;
  onNewPublish: () => void;
  onManageTargets: () => void;
}

function PublishSidebar(props: PublishSidebarProps) {
  const newPublishActive = props.selectedPublishIds.size === 0;
  return (
    <>
      <div className="publish-sidebar-target">
        <label className="publish-kv-key" htmlFor="publish-target-select">
          Target
        </label>
        <select
          id="publish-target-select"
          value={props.selectedTargetId ?? ""}
          onChange={(e) => props.onSelectTarget(e.target.value)}
        >
          {props.settings.targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
        <button type="button" className="link" onClick={props.onManageTargets}>
          Manage…
        </button>
      </div>
      <div className="publish-sidebar-usage">
        <span>Used on this target</span>
        <strong>{formatBytes(props.totalBytes)}</strong>
      </div>
      <div className="publish-sidebar-list">
        {/* "New publish" is the top item — selecting it puts the form in
            create-mode (no existing publish-id reused). */}
        <div
          className={`publish-sidebar-item publish-sidebar-item-new${newPublishActive ? " is-active" : ""}`}
        >
          <button
            type="button"
            className="publish-sidebar-item-main"
            onClick={props.onNewPublish}
            title="Start a fresh publish (creates a new URL)"
          >
            <div className="publish-sidebar-item-title">+ New publish</div>
            <div className="publish-sidebar-item-meta">Fresh URL · doesn't replace any existing publish</div>
          </button>
        </div>
        {props.publishes.length === 0 ? (
          <div className="publish-sidebar-empty">No existing publishes on this target.</div>
        ) : (
          props.publishes.map((entry) => {
            const size = bytesForPublish(entry);
            const isSelected = props.selectedPublishIds.has(entry.publishId);
            return (
              <div
                key={entry.publishId}
                className={`publish-sidebar-item${isSelected ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="publish-sidebar-item-main"
                  onClick={(event) =>
                    props.onSelectPublish(entry, {
                      ctrl: event.ctrlKey || event.metaKey,
                      shift: event.shiftKey
                    })
                  }
                  title="Click to re-publish over this entry · Ctrl/Cmd+click to multi-select · Shift+click for range"
                >
                  <div className="publish-sidebar-item-title">{entry.title || entry.publishId}</div>
                  <div className="publish-sidebar-item-meta">
                    {formatBytes(size)} · {formatRelativeTime(entry.lastPublishedAtIso)}
                  </div>
                </button>
                <div className="publish-sidebar-item-actions">
                  <button
                    type="button"
                    title="Open viewer URL in browser"
                    aria-label="Open viewer URL in browser"
                    disabled={!entry.viewerUrl}
                    onClick={() => props.onOpenPublish(entry)}
                  >
                    <FontAwesomeIcon icon={faGlobe} />
                  </button>
                  <button
                    type="button"
                    title="Copy viewer URL to clipboard"
                    aria-label="Copy viewer URL"
                    disabled={!entry.viewerUrl}
                    onClick={() => props.onCopyPublishUrl(entry)}
                  >
                    <FontAwesomeIcon icon={faLink} />
                  </button>
                  <button
                    type="button"
                    className="danger"
                    title="Delete this publish"
                    aria-label="Delete publish"
                    onClick={() => props.onDeletePublish(entry)}
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

type ViewerStrategyValue = "deploy" | "use-last" | "override";

interface ViewerSectionProps {
  viewerUrl: string;
  versionCheck: PublishCheckViewerVersionResult | null;
  versionChecking: boolean;
  effectiveSha: string;
  currentEditorSha: string;
  lastDeployedSha?: string | null;
  lastDeployedAlsoCurrent: boolean;
  hasVercelToken: boolean;
  accountLabel?: string;
  deployJobId: string | null;
  activeJobId: string | null;
  strategy: ViewerStrategyValue | null;
  onChangeStrategy: (next: ViewerStrategyValue) => void;
  onRunVersionCheck: () => void;
  onOpenVercelSettings: () => void;
}

function ViewerSection(props: ViewerSectionProps) {
  const deploying = Boolean(props.deployJobId);
  const showStrategyChoice =
    !!props.versionCheck && !props.versionCheck.deployed && !props.versionChecking && !deploying;
  const useLastSha = props.lastDeployedSha && !props.lastDeployedAlsoCurrent ? props.lastDeployedSha : null;
  const disabled = Boolean(props.activeJobId);

  return (
    <>
      <div className="publish-section-row">
        <div className="publish-section-kv">
          <span className="publish-kv-key">URL</span>
          <code>{props.viewerUrl}</code>
        </div>
        <div className="publish-section-kv">
          <span className="publish-kv-key">Pinned to viewer</span>
          <code>v{props.effectiveSha}</code>
        </div>
      </div>

      <PreflightRow
        result={props.versionCheck}
        checking={props.versionChecking}
        sha={props.effectiveSha}
        onRetry={props.onRunVersionCheck}
      />

      {showStrategyChoice ? (
        <fieldset className="publish-viewer-strategy">
          <legend>Choose how to publish</legend>
          <ViewerStrategyOption
            value="deploy"
            checked={props.strategy === "deploy"}
            onSelect={() => props.onChangeStrategy("deploy")}
            disabled={disabled || !props.hasVercelToken}
            label={
              props.hasVercelToken
                ? `Deploy viewer v${props.currentEditorSha} first, then publish`
                : `Deploy viewer v${props.currentEditorSha} first (Vercel not connected)`
            }
            description={
              props.hasVercelToken
                ? `Builds and pushes the current viewer to Vercel (${props.accountLabel ?? "your account"}), then runs the publish — one click, both steps.`
                : "Connect a Vercel account to enable this option."
            }
            extra={
              !props.hasVercelToken ? (
                <button type="button" className="link" onClick={props.onOpenVercelSettings}>
                  Connect Vercel…
                </button>
              ) : null
            }
          />
          {useLastSha ? (
            <ViewerStrategyOption
              value="use-last"
              checked={props.strategy === "use-last"}
              onSelect={() => props.onChangeStrategy("use-last")}
              disabled={disabled}
              label={`Use viewer v${useLastSha} (last deployed)`}
              description="Pin this publish to the last deployed viewer. Your URL works immediately; you can deploy the current sha later and re-publish if you want."
            />
          ) : null}
          <ViewerStrategyOption
            value="override"
            checked={props.strategy === "override"}
            onSelect={() => props.onChangeStrategy("override")}
            disabled={disabled}
            label="Publish anyway (no viewer)"
            description={
              <>
                Snapshot uploads to R2; <code>/v/{props.effectiveSha}/p/&lt;id&gt;</code> will 404 until
                a viewer for this sha is hosted at the configured viewer URL.
              </>
            }
          />
        </fieldset>
      ) : null}

      {props.hasVercelToken ? (
        <div className="publish-viewer-footer">
          <span className="publish-modal-hint">
            Vercel: {props.accountLabel ?? "connected"}
            {props.lastDeployedSha ? ` · last deployed v${props.lastDeployedSha}` : ""}
          </span>
          <button type="button" className="link" onClick={props.onOpenVercelSettings}>
            Manage Vercel…
          </button>
        </div>
      ) : null}
    </>
  );
}

interface ViewerStrategyOptionProps {
  value: ViewerStrategyValue;
  checked: boolean;
  onSelect: () => void;
  disabled: boolean;
  label: string;
  description: React.ReactNode;
  extra?: React.ReactNode;
}

function ViewerStrategyOption(props: ViewerStrategyOptionProps) {
  return (
    <label
      className={`publish-viewer-strategy-option${props.checked ? " is-checked" : ""}${props.disabled ? " is-disabled" : ""}`}
    >
      <input
        type="radio"
        name="publish-viewer-strategy"
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => {
          if (!props.disabled) props.onSelect();
        }}
      />
      <div className="publish-viewer-strategy-option-body">
        <div className="publish-viewer-strategy-option-label">{props.label}</div>
        <div className="publish-viewer-strategy-option-desc">{props.description}</div>
        {props.extra ? <div className="publish-viewer-strategy-option-extra">{props.extra}</div> : null}
      </div>
    </label>
  );
}

interface PreflightRowProps {
  result: PublishCheckViewerVersionResult | null;
  checking: boolean;
  sha: string;
  onRetry: () => void;
}

function PreflightRow({ result, checking, sha, onRetry }: PreflightRowProps) {
  let statusClass = "publish-preflight-row";
  let statusText: string;
  if (checking) {
    statusText = `Checking viewer v${sha}…`;
    statusClass += " is-checking";
  } else if (!result) {
    statusText = "Pre-flight not run.";
  } else if (result.deployed) {
    statusText = `Viewer v${sha} is deployed.`;
    statusClass += " is-ok";
  } else if (result.error) {
    // Actual fetch failure (DNS, network, malformed response, etc.) — this
    // IS an error.
    statusText = `Viewer v${sha} unavailable: ${result.error}`;
    statusClass += " is-error";
  } else {
    // Expected state: HEAD 404 because the viewer hasn't been deployed yet.
    // Not an error — a normal "you should deploy first" cue.
    statusText = `⚠ Viewer v${sha} not yet released (HTTP ${String(result.status ?? "—")}).`;
    statusClass += " is-warning";
  }
  return (
    <div className={statusClass}>
      <span>{statusText}</span>
      <button type="button" className="link" onClick={onRetry} disabled={checking}>
        Retry
      </button>
    </div>
  );
}

function FooterProgress({ progress }: { progress: ProgressState }) {
  const percent = progress.overallProgress !== undefined ? Math.round(progress.overallProgress * 100) : null;
  return (
    <div className="publish-footer-progress">
      <div className="publish-footer-progress-bar">
        <div
          className="publish-footer-progress-fill"
          style={{ width: percent === null ? "10%" : `${String(Math.max(2, percent))}%` }}
        />
      </div>
      <div className="publish-footer-progress-label">
        <span className="publish-footer-progress-phase">{phaseLabel(progress)}</span>
        {percent !== null ? <span className="publish-footer-progress-pct">{percent}%</span> : null}
        {progress.currentItem ? (
          <span className="publish-footer-progress-item">{progress.currentItem}</span>
        ) : null}
      </div>
    </div>
  );
}

function ProgressPanel({ progress }: { progress: ProgressState }) {
  const percent = progress.overallProgress !== undefined ? Math.round(progress.overallProgress * 100) : null;
  return (
    <section className="publish-section publish-modal-progress">
      <header>
        <h4>{phaseLabel(progress)}</h4>
        {percent !== null ? <span>{percent}%</span> : null}
      </header>
      <div className="publish-progress-bar">
        <div
          className="publish-progress-bar-fill"
          style={{
            width: percent === null ? "10%" : `${String(Math.max(2, percent))}%`
          }}
        />
      </div>
      {progress.currentItem ? <div className="publish-progress-current">{progress.currentItem}</div> : null}
      {progress.message ? <div className="publish-progress-message">{progress.message}</div> : null}
      {progress.error ? <div className="publish-modal-error">{progress.error}</div> : null}
    </section>
  );
}

function phaseLabel(state: ProgressState): string {
  // Deploy and publish share `done` / `error` phase names — disambiguate
  // via the kind so the label matches what the user is looking at.
  if (state.kind === "deploy") {
    switch (state.phase) {
      case "build":
        return "Building viewer bundle";
      case "project":
        return "Preparing Vercel project";
      case "deploy":
        return "Deploying viewer";
      case "ready":
        return "Viewer ready";
      case "done":
        return "Viewer deployed";
      case "error":
        return "Deploy failed";
      default:
        return state.phase;
    }
  }
  switch (state.phase) {
    case "preflight":
      return "Preflight";
    case "snapshot-scan":
      return "Scanning snapshots";
    case "plugin-bundle":
      return "Bundling plugins";
    case "asset-hash":
      return "Hashing assets";
    case "existence-check":
      return "Checking remote";
    case "asset-upload":
      return "Uploading assets";
    case "plugin-upload":
      return "Uploading plugins";
    case "snapshot-upload":
      return "Uploading snapshots";
    case "config-upload":
      return "Uploading viewer config";
    case "manifest-upload":
      return "Uploading manifest";
    case "switch-live":
      return "Going live";
    case "gc":
      return "Cleaning up";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return state.phase;
  }
}

function DonePanel({ viewerUrl }: { viewerUrl: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="publish-section publish-modal-done">
      <header>
        <h4>Published</h4>
      </header>
      <div className="publish-section-body">
        <div className="publish-modal-done-url">
          <code>{viewerUrl}</code>
        </div>
        <div className="publish-modal-done-actions">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(viewerUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
          <button
            type="button"
            onClick={() => {
              void openExternalUrl(viewerUrl);
            }}
          >
            Open in browser
          </button>
        </div>
      </div>
    </section>
  );
}


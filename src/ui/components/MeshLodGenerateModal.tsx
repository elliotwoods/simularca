import { useEffect, useRef, useState } from "react";
import {
  decimateMeshGlb,
  DecimationCanceledError,
  DecimationError,
  type DecimationProgress,
  type DecimationResult,
  type MeshSourceFormat
} from "@/features/mesh/meshDecimation";

interface Props {
  open: boolean;
  sourceFileName: string;
  sourceTriangleCount: number;
  format: MeshSourceFormat;
  loadSourceBytes: () => Promise<Uint8Array>;
  onComplete: (results: DecimationResult[]) => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}

const DEFAULT_RATIOS_INPUT = "0.5, 0.25, 0.1";
const DEFAULT_ERROR_TARGET = 0.01;

type Phase = "settings" | "running" | "complete";

interface DraftSettings {
  ratiosInput: string;
  errorTarget: number;
  preserveBorders: boolean;
}

const DEFAULT_DRAFT: DraftSettings = {
  ratiosInput: DEFAULT_RATIOS_INPUT,
  errorTarget: DEFAULT_ERROR_TARGET,
  preserveBorders: true
};

function parseRatios(input: string): number[] {
  return input
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 1);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function MeshLodGenerateModal(props: Props) {
  const [phase, setPhase] = useState<Phase>("settings");
  const [draft, setDraft] = useState<DraftSettings>(DEFAULT_DRAFT);
  const [error, setError] = useState<string>("");
  const [progress, setProgress] = useState<DecimationProgress | null>(null);
  const [results, setResults] = useState<DecimationResult[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const cancelTokenRef = useRef<{ canceled: boolean } | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Reset state every time the modal re-opens.
  useEffect(() => {
    if (props.open) {
      setPhase("settings");
      setDraft(DEFAULT_DRAFT);
      setError("");
      setProgress(null);
      setResults([]);
      setElapsedMs(0);
      cancelTokenRef.current = null;
      startedAtRef.current = null;
    }
  }, [props.open]);

  // Tick elapsed time during a run for the "elapsed" label.
  useEffect(() => {
    if (phase !== "running") return;
    const handle = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(performance.now() - startedAtRef.current);
      }
    }, 200);
    return () => window.clearInterval(handle);
  }, [phase]);

  if (!props.open) {
    return null;
  }

  const ratios = parseRatios(draft.ratiosInput);
  const settingsValid = ratios.length > 0 && Number.isFinite(draft.errorTarget) && draft.errorTarget >= 0;

  const startGeneration = async () => {
    if (!settingsValid) {
      setError(
        ratios.length === 0
          ? "Enter at least one ratio between 0 and 1 (e.g. 0.5, 0.25, 0.1)"
          : "Error target must be a non-negative number."
      );
      return;
    }
    setError("");
    setProgress({ stage: "parse", completed: 0, total: 1, message: "Loading source asset..." });
    setPhase("running");
    setResults([]);
    cancelTokenRef.current = { canceled: false };
    startedAtRef.current = performance.now();
    setElapsedMs(0);

    try {
      const sourceBytes = await props.loadSourceBytes();
      if (cancelTokenRef.current.canceled) {
        throw new DecimationCanceledError();
      }
      const generated = await decimateMeshGlb(sourceBytes, {
        ratios,
        format: props.format,
        errorTarget: draft.errorTarget,
        preserveBorders: draft.preserveBorders,
        onProgress: (p) => setProgress(p),
        cancelToken: cancelTokenRef.current
      });
      if (cancelTokenRef.current.canceled) {
        throw new DecimationCanceledError();
      }
      // Hand off to the caller for asset-write / store updates. The caller may itself be slow,
      // so keep the modal in a "running" view with a generic message until it finishes.
      setProgress({
        stage: "export",
        completed: 1,
        total: 1,
        message: `Saving ${generated.length} LOD${generated.length === 1 ? "" : "s"} to project...`
      });
      await props.onComplete(generated);
      if (cancelTokenRef.current.canceled) {
        // Caller may have ignored the cancel; treat as canceled if we requested it.
        throw new DecimationCanceledError();
      }
      setResults(generated);
      setPhase("complete");
    } catch (err) {
      if (err instanceof DecimationCanceledError) {
        // User-initiated cancel — close silently.
        props.onClose();
        return;
      }
      const message = err instanceof DecimationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      console.error("[lod] generation failed:", err);
      props.onError(message);
      props.onClose();
    }
  };

  const requestCancel = () => {
    if (cancelTokenRef.current) {
      cancelTokenRef.current.canceled = true;
    }
  };

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    if (phase === "running") return; // can't dismiss mid-run by clicking outside
    props.onClose();
  };

  const ratio = progress && progress.total > 0
    ? Math.max(0, Math.min(1, progress.completed / progress.total))
    : 0;

  return (
    <div className="lod-modal-backdrop" onClick={handleBackdropClick}>
      <div className="lod-modal render-modal" role="dialog" aria-modal="true" aria-label="Generate LODs">
        <h3>Generate LODs</h3>
        <div className="lod-modal-source">
          <strong>{props.sourceFileName}</strong>
          {props.sourceTriangleCount > 0
            ? ` — ${props.sourceTriangleCount.toLocaleString()} triangles`
            : null}
        </div>

        {phase === "settings" ? (
          <>
            <div className="lod-modal-grid">
              <label>
                Ratios
                <input
                  type="text"
                  value={draft.ratiosInput}
                  placeholder={DEFAULT_RATIOS_INPUT}
                  onChange={(e) => setDraft((prev) => ({ ...prev, ratiosInput: e.target.value }))}
                />
                <span className="lod-modal-hint">
                  Comma-separated, each between 0 and 1. Detected: {ratios.length > 0
                    ? ratios.map((r) => `${Math.round(r * 100)}%`).join(", ")
                    : "none"}
                </span>
              </label>
              <label>
                Error Target
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  max={0.5}
                  value={draft.errorTarget}
                  onChange={(e) => setDraft((prev) => ({ ...prev, errorTarget: Number(e.target.value) }))}
                />
                <span className="lod-modal-hint">
                  Higher values allow more aggressive simplification at the cost of shape fidelity. Default 0.01.
                </span>
              </label>
              <label className="lod-modal-toggle">
                <input
                  type="checkbox"
                  checked={draft.preserveBorders}
                  onChange={(e) => setDraft((prev) => ({ ...prev, preserveBorders: e.target.checked }))}
                />
                <span>Preserve borders / UV seams</span>
              </label>
            </div>
            {error ? <p className="render-modal-error">{error}</p> : null}
            <div className="render-modal-actions">
              <button type="button" onClick={props.onClose}>Cancel</button>
              <button type="button" disabled={!settingsValid} onClick={() => { void startGeneration(); }}>
                Generate
              </button>
            </div>
          </>
        ) : null}

        {phase === "running" ? (
          <>
            <div
              className="lod-modal-progress render-overlay-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
            >
              <span style={{ width: `${ratio * 100}%` }} />
            </div>
            <div className="lod-modal-status">
              <p>{progress?.message ?? "Working..."}</p>
              <p className="lod-modal-hint">
                {progress
                  ? `${progress.completed} / ${progress.total} units · ${formatDuration(elapsedMs)} elapsed`
                  : `${formatDuration(elapsedMs)} elapsed`}
              </p>
            </div>
            <div className="render-modal-actions">
              <button type="button" onClick={requestCancel} disabled={cancelTokenRef.current?.canceled === true}>
                {cancelTokenRef.current?.canceled ? "Canceling..." : "Cancel"}
              </button>
            </div>
          </>
        ) : null}

        {phase === "complete" ? (
          <>
            <p className="lod-modal-hint">
              Generated {results.length} LOD{results.length === 1 ? "" : "s"} in {formatDuration(elapsedMs)}.
            </p>
            <table className="mesh-lod-table">
              <thead>
                <tr>
                  <th>Ratio</th>
                  <th>Triangles</th>
                  <th>Reduction</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const reduction = r.originalTriangleCount > 0
                    ? Math.round((1 - r.triangleCount / r.originalTriangleCount) * 100)
                    : 0;
                  return (
                    <tr key={r.ratio}>
                      <td>{Math.round(r.ratio * 100)}%</td>
                      <td>{r.triangleCount.toLocaleString()}</td>
                      <td>−{reduction}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="render-modal-actions">
              <button type="button" onClick={props.onClose}>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

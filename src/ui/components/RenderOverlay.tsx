import { useEffect, useRef, useState } from "react";
import type { RenderProgress } from "@/features/render/types";

interface RenderOverlayProps {
  open: boolean;
  progress: RenderProgress | null;
  onHostReady: (host: HTMLDivElement | null) => void;
  onCancel: () => void;
}

function formatDuration(valueMs: number | null): string {
  if (valueMs === null || !Number.isFinite(valueMs)) {
    return "Estimating...";
  }
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function RenderOverlay({ open, progress, onHostReady, onCancel }: RenderOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const startedAtMsRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => performance.now());

  useEffect(() => {
    onHostReady(open ? hostRef.current : null);
    return () => {
      onHostReady(null);
    };
  }, [onHostReady, open]);

  useEffect(() => {
    if (!open) {
      startedAtMsRef.current = null;
      return;
    }
    if (progress && startedAtMsRef.current === null) {
      startedAtMsRef.current = performance.now();
    }
  }, [open, progress]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handle = window.setInterval(() => {
      setNowMs(performance.now());
    }, 250);
    return () => {
      window.clearInterval(handle);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const frameIndex = progress ? Math.min(progress.frameIndex + 1, progress.frameCount) : 0;
  const frameCount = progress?.frameCount ?? 0;
  const ratio = frameCount > 0 ? Math.max(0, Math.min(1, frameIndex / frameCount)) : 0;
  const startedAtMs = startedAtMsRef.current;
  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  const estimatedTotalMs = ratio > 0 ? elapsedMs / ratio : null;
  const estimatedRemainingMs = estimatedTotalMs === null ? null : Math.max(0, estimatedTotalMs - elapsedMs);

  return (
    <div className="render-overlay-backdrop">
      <div className="render-overlay">
        <header>
          <h3>Rendering</h3>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </header>
        <div className="render-overlay-canvas-host" ref={hostRef} />
        <footer>
          <div className="render-overlay-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio * 100}>
            <span style={{ width: `${ratio * 100}%` }} />
          </div>
          {progress ? <p>Frame {frameIndex} / {frameCount}</p> : <p>Starting render...</p>}
          <p>Status: {progress?.message ?? "Preparing..."}</p>
          <p>Time Spent: {formatDuration(elapsedMs)}</p>
          <p>Time Remaining (est): {formatDuration(estimatedRemainingMs)}</p>
          <p>Time Total (est): {formatDuration(estimatedTotalMs)}</p>
        </footer>
      </div>
    </div>
  );
}

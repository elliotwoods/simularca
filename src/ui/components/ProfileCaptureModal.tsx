import { useEffect, useState } from "react";
import type { ProfileCaptureOptions, ProfilingPublicState } from "@/render/profiling";

interface ProfileCaptureModalProps {
  open: boolean;
  profilingState: ProfilingPublicState;
  onCancel: () => void;
  onConfirm: (options: ProfileCaptureOptions) => void;
}

const DEFAULT_OPTIONS: ProfileCaptureOptions = {
  frameCount: 10,
  includeUpdateTimings: true,
  includeDrawTimings: true,
  includeGpuTimings: true,
  detailPreset: "standard"
};

export function ProfileCaptureModal(props: ProfileCaptureModalProps) {
  const [draft, setDraft] = useState<ProfileCaptureOptions>(DEFAULT_OPTIONS);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setDraft(DEFAULT_OPTIONS);
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const captureActive = props.profilingState.phase === "capturing";

  return (
    <div
      className="render-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div className="render-modal profile-modal" role="dialog" aria-modal="true" aria-label="Performance profile">
        <h3>Capture Performance Profile</h3>
        <div className="render-modal-grid profile-modal-grid">
          <label>
            Frames
            <input
              type="number"
              min={1}
              max={2000}
              step={1}
              autoFocus
              value={draft.frameCount}
              onFocus={(e) => e.target.select()}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  frameCount: Math.max(1, Math.min(2000, Math.round(Number(event.target.value) || 1)))
                }))
              }
            />
          </label>
          <label>
            Detail
            <select
              value={draft.detailPreset}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  detailPreset: event.target.value === "minimal" ? "minimal" : "standard"
                }))
              }
            >
              <option value="standard">Standard</option>
              <option value="minimal">Minimal</option>
            </select>
          </label>
          <label className="profile-modal-toggle">
            <input
              type="checkbox"
              checked={draft.includeUpdateTimings}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  includeUpdateTimings: event.target.checked
                }))
              }
            />
            <span>Profile update timings</span>
          </label>
          <label className="profile-modal-toggle">
            <input
              type="checkbox"
              checked={draft.includeDrawTimings}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  includeDrawTimings: event.target.checked
                }))
              }
            />
            <span>Profile draw timings</span>
          </label>
          <label className="profile-modal-toggle">
            <input
              type="checkbox"
              checked={draft.includeGpuTimings}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  includeGpuTimings: event.target.checked
                }))
              }
            />
            <span>Profile GPU timings</span>
          </label>
        </div>
        {captureActive ? (
          <div className="profile-modal-status">
            Capturing frame {props.profilingState.capturedFrameCount + 1} of {props.profilingState.requestedFrameCount}
            {props.profilingState.pendingGpuFrames > 0 ? " and waiting for GPU timestamps." : "."}
          </div>
        ) : null}
        <div className="render-modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => props.onConfirm(draft)}
            disabled={captureActive || (!draft.includeUpdateTimings && !draft.includeDrawTimings && !draft.includeGpuTimings)}
          >
            Start Capture
          </button>
        </div>
      </div>
    </div>
  );
}

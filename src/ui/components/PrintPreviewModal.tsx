import { useEffect, useMemo, useRef, useState } from "react";
import { composePrintCanvas } from "@/features/print/composePrint";
import {
  PAPER_LABELS,
  PRINT_SCALE_PRESETS,
  formatScaleRatio,
  paperDimensionsMm,
  paperPixelSize,
  scaleToWorldViewHeight
} from "@/features/print/paper";
import type { PrintFrameResult } from "@/features/print/runPrint";
import type { PaperSize, PrintOrientation, PrintOutput, PrintSettings } from "@/features/print/types";
import { BufferedNumberTextInput } from "@/ui/widgets/BufferedNumberTextInput";

interface PrintPreviewModalProps {
  open: boolean;
  isElectron: boolean;
  isOrthographic: boolean;
  defaults: PrintSettings;
  requestBaseFrame: (settings: PrintSettings) => Promise<PrintFrameResult>;
  onCancel: () => void;
  onConfirm: (settings: PrintSettings) => void;
}

const PREVIEW_DEBOUNCE_MS = 300;

function formatMeters(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
}

/** Settings that change the offscreen 3D render (aspect / zoom), so the base
 *  frame must be regenerated. Invert / ruler / output recompose instantly. */
function renderKey(settings: PrintSettings): string {
  return [settings.paper, settings.orientation, settings.scaleMode, settings.scaleRatio].join("|");
}

export function PrintPreviewModal(props: PrintPreviewModalProps) {
  const [draft, setDraft] = useState<PrintSettings>(props.defaults);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const baseRef = useRef<{ key: string; frame: PrintFrameResult } | null>(null);
  const requestSeqRef = useRef(0);

  // Reset the draft each time the modal opens; perspective forces fit mode.
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const next = props.isOrthographic ? props.defaults : { ...props.defaults, scaleMode: "fit" as const };
    setDraft(next);
    setError("");
    setPreviewUrl("");
    baseRef.current = null;
  }, [props.open, props.defaults, props.isOrthographic]);

  // Regenerate the base 3D frame (debounced) when render-affecting settings change.
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const key = renderKey(draft);
    if (baseRef.current?.key === key) {
      return;
    }
    const seq = (requestSeqRef.current += 1);
    setBusy(true);
    const handle = window.setTimeout(() => {
      void props
        .requestBaseFrame(draft)
        .then((frame) => {
          if (seq !== requestSeqRef.current) {
            return;
          }
          baseRef.current = { key, frame };
          setError("");
        })
        .catch((err: unknown) => {
          if (seq !== requestSeqRef.current) {
            return;
          }
          baseRef.current = null;
          setError(err instanceof Error ? err.message : "Preview failed.");
        })
        .finally(() => {
          if (seq === requestSeqRef.current) {
            setBusy(false);
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, draft.paper, draft.orientation, draft.scaleMode, draft.scaleRatio]);

  // Recompose invert + ruler whenever the draft or base frame changes.
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const base = baseRef.current;
    if (!base) {
      return;
    }
    try {
      const composed = composePrintCanvas({
        source: base.frame.canvas,
        settings: draft,
        pixelsPerMeter: base.frame.pixelsPerMeter
      });
      setPreviewUrl(composed.toDataURL("image/png"));
    } catch {
      // ignore compose failures; preview just stays stale
    }
  }, [props.open, draft, busy]);

  const { wmm, hmm } = useMemo(
    () => paperDimensionsMm(draft.paper, draft.orientation),
    [draft.paper, draft.orientation]
  );
  const outputPx = useMemo(
    () => paperPixelSize(draft.paper, draft.orientation, draft.dpi),
    [draft.paper, draft.orientation, draft.dpi]
  );
  const usesScale = draft.scaleMode === "ratio" && props.isOrthographic;
  const spanH = usesScale ? scaleToWorldViewHeight(hmm, draft.scaleRatio) : 0;
  const spanW = usesScale ? scaleToWorldViewHeight(wmm, draft.scaleRatio) : 0;

  if (!props.open) {
    return null;
  }

  const scaleSelectValue = draft.scaleMode === "fit" ? "fit" : String(draft.scaleRatio);

  const submit = () => {
    if (!props.isElectron && (draft.output === "pdf" || draft.output === "dialog")) {
      setError("PDF and printing are only available in the desktop app.");
      return;
    }
    props.onConfirm(draft);
  };

  return (
    <div
      className="print-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div className="print-modal" role="dialog" aria-modal="true" aria-label="Print preview and settings">
        <h3>Print</h3>
        <div className="print-modal-body">
          <div className="print-modal-form">
            <label>
              Paper Size
              <select
                value={draft.paper}
                onChange={(event) => setDraft((prev) => ({ ...prev, paper: event.target.value as PaperSize }))}
              >
                {(Object.keys(PAPER_LABELS) as PaperSize[]).map((size) => (
                  <option key={size} value={size}>
                    {PAPER_LABELS[size]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Orientation
              <select
                value={draft.orientation}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, orientation: event.target.value as PrintOrientation }))
                }
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <label>
              Resolution (DPI)
              <BufferedNumberTextInput
                value={draft.dpi}
                min={72}
                step={1}
                precision={0}
                onChange={(next) => setDraft((prev) => ({ ...prev, dpi: Math.round(next) }))}
              />
            </label>
            <label>
              Scale
              <select
                value={scaleSelectValue}
                disabled={!props.isOrthographic}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "fit") {
                    setDraft((prev) => ({ ...prev, scaleMode: "fit" }));
                  } else {
                    setDraft((prev) => ({ ...prev, scaleMode: "ratio", scaleRatio: Number(value) }));
                  }
                }}
              >
                <option value="fit">Fit to page</option>
                {PRINT_SCALE_PRESETS.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {formatScaleRatio(ratio)}
                  </option>
                ))}
              </select>
            </label>
            {usesScale ? (
              <label>
                Custom Scale (1:N)
                <BufferedNumberTextInput
                  value={draft.scaleRatio}
                  min={1}
                  step={1}
                  precision={2}
                  onChange={(next) => setDraft((prev) => ({ ...prev, scaleRatio: Math.max(1, next) }))}
                />
              </label>
            ) : null}
            <label className="print-modal-checkbox">
              <span>Invert Colors</span>
              <input
                type="checkbox"
                checked={draft.invert}
                onChange={(event) => setDraft((prev) => ({ ...prev, invert: event.target.checked }))}
              />
            </label>
            <label className="print-modal-checkbox">
              <span>Edge Ruler</span>
              <input
                type="checkbox"
                checked={draft.showRuler}
                disabled={!usesScale}
                onChange={(event) => setDraft((prev) => ({ ...prev, showRuler: event.target.checked }))}
              />
            </label>
            <label>
              Output
              <select
                value={draft.output}
                onChange={(event) => setDraft((prev) => ({ ...prev, output: event.target.value as PrintOutput }))}
              >
                <option value="dialog" disabled={!props.isElectron}>
                  Print dialog
                </option>
                <option value="pdf" disabled={!props.isElectron}>
                  Save PDF
                </option>
                <option value="png">Save PNG</option>
              </select>
            </label>
            {!props.isOrthographic ? (
              <p className="print-modal-note">Scale &amp; ruler are only available in orthographic view (press 5).</p>
            ) : null}
          </div>
          <div className="print-preview">
            <div className={`print-preview-stage print-preview-${draft.orientation}`}>
              {previewUrl ? (
                <img src={previewUrl} alt="Print preview" />
              ) : (
                <div className="print-preview-placeholder">{busy ? "Generating preview…" : "Preview"}</div>
              )}
              {busy && previewUrl ? <div className="print-preview-spinner">Updating…</div> : null}
            </div>
          </div>
        </div>
        <div className="print-modal-readout">
          <span>
            <strong>Page:</strong> {PAPER_LABELS[draft.paper]} {draft.orientation} · {wmm}×{hmm} mm
          </span>
          <span>
            <strong>Output:</strong> {outputPx.width}×{outputPx.height} px @ {draft.dpi} dpi
          </span>
          {usesScale ? (
            <span>
              <strong>Spans:</strong> {formatMeters(spanW)} × {formatMeters(spanH)} m at {formatScaleRatio(draft.scaleRatio)}
            </span>
          ) : null}
        </div>
        {error ? <p className="print-modal-error">{error}</p> : null}
        <div className="print-modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}>
            {draft.output === "png" ? "Save PNG" : draft.output === "pdf" ? "Save PDF" : "Print"}
          </button>
        </div>
      </div>
    </div>
  );
}

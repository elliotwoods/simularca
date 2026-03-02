import { useEffect, useState } from "react";
import type { ActorFileImportOption } from "@/features/imports/actorFileImport";

interface FileImportModalProps {
  open: boolean;
  fileName: string;
  fileExtension: string;
  options: ActorFileImportOption[];
  onConfirm: (descriptorId: string) => void;
  onCancel: () => void;
}

export function FileImportModal(props: FileImportModalProps) {
  const [selected, setSelected] = useState("");

  useEffect(() => {
    if (props.open) {
      setSelected(props.options[0]?.descriptorId ?? "");
    }
  }, [props.open, props.options]);

  if (!props.open) {
    return null;
  }

  return (
    <div
      className="file-import-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div className="file-import-modal" role="dialog" aria-modal="true" aria-label="Choose actor type for import">
        <h3>Import File</h3>
        <p className="panel-empty">{props.fileName}</p>
        <p className="panel-empty">Extension: {props.fileExtension || "(none)"}</p>
        {props.options.length === 0 ? (
          <p className="panel-empty">No actor types can load this file extension.</p>
        ) : (
          <label>
            Actor type
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {props.options.map((option) => (
                <option key={option.descriptorId} value={option.descriptorId}>
                  {option.label} ({option.fileExtensions.join(", ")})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="file-import-modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (selected) {
                props.onConfirm(selected);
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

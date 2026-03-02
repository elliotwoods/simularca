import { useEffect, useState } from "react";

interface TextInputModalProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function TextInputModal(props: TextInputModalProps) {
  const [value, setValue] = useState(props.initialValue ?? "");

  useEffect(() => {
    if (props.open) {
      setValue(props.initialValue ?? "");
    }
  }, [props.open, props.initialValue]);

  if (!props.open) {
    return null;
  }

  return (
    <div
      className="text-input-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div className="text-input-modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        <label>
          {props.label}
          <input
            type="text"
            value={value}
            placeholder={props.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onConfirm(value);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancel();
              }
            }}
            autoFocus
          />
        </label>
        <div className="text-input-modal-actions">
          <button type="button" onClick={props.onCancel}>
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => props.onConfirm(value)}
            disabled={value.trim().length === 0}
          >
            {props.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

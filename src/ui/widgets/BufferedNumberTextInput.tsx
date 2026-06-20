import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import {
  formatNumberValue,
  inferDisplayPrecision,
  normalizeCommittedNumber,
  parseDraftNumber
} from "@/ui/widgets/numberEditing";

interface BufferedNumberTextInputProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  onChange: (value: number) => void;
}

export function BufferedNumberTextInput(props: BufferedNumberTextInputProps) {
  const precision = useMemo(
    () => inferDisplayPrecision(props.precision, props.step),
    [props.precision, props.step]
  );
  const [draft, setDraft] = useState(() => formatNumberValue(props.value, precision));
  const [editing, setEditing] = useState(false);
  const skipBlurCommitRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(formatNumberValue(props.value, precision));
    }
  }, [editing, precision, props.value]);

  const parsedDraft = useMemo(() => parseDraftNumber(draft), [draft]);
  const invalid = editing && draft.trim().length > 0 && parsedDraft === null;

  const cancelDraft = () => {
    setDraft(formatNumberValue(props.value, precision));
    setEditing(false);
  };

  const commitDraft = () => {
    setEditing(false);
    if (parsedDraft === null) {
      setDraft(formatNumberValue(props.value, precision));
      return;
    }
    const next = normalizeCommittedNumber(parsedDraft, {
      min: props.min,
      max: props.max,
      step: props.step,
      precision
    });
    props.onChange(next);
    setDraft(formatNumberValue(next, precision));
  };

  const wrapperClassName = `widget-buffered-number${invalid ? " is-invalid" : ""}${props.className ? ` ${props.className}` : ""}`;
  const inputClassName = props.inputClassName ?? "";

  return (
    <span className={wrapperClassName}>
      <input
        ref={inputRef}
        type="text"
        inputMode={props.inputMode ?? "decimal"}
        className={inputClassName}
        value={draft}
        disabled={props.disabled}
        aria-invalid={invalid}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          setEditing(true);
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
          }
          if (invalid) {
            // Reject the commit: keep the field open and focused so the user
            // can fix the formula or press Escape to revert.
            window.setTimeout(() => inputRef.current?.focus(), 0);
            return;
          }
          commitDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (invalid) {
              return;
            }
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            skipBlurCommitRef.current = true;
            cancelDraft();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      {invalid ? (
        <span className="widget-buffered-number-indicator" aria-hidden="true" title="Invalid number">
          !
        </span>
      ) : null}
    </span>
  );
}

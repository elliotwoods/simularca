import { useEffect, useMemo, useRef, useState } from "react";

interface DigitToken {
  char: string;
  place?: number;
}

interface DigitScrubInputProps {
  value: number;
  mixed?: boolean;
  precision?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function formatValue(value: number, precision: number): string {
  return Number.isFinite(value) ? value.toFixed(precision) : (0).toFixed(precision);
}

function tokensFromFormatted(formatted: string): DigitToken[] {
  const decimalIndex = formatted.indexOf(".");
  const dot = decimalIndex === -1 ? formatted.length : decimalIndex;
  const tokens: DigitToken[] = [];
  for (let i = 0; i < formatted.length; i += 1) {
    const char = formatted.charAt(i);
    if (char >= "0" && char <= "9") {
      const place = i < dot ? dot - i - 1 : dot - i;
      tokens.push({ char, place });
    } else {
      tokens.push({ char });
    }
  }
  return tokens;
}

function roundToPrecision(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, precision)));
}

function setGlobalScrubMode(active: boolean): void {
  const className = "is-scrubbing-number";
  if (active) {
    document.body.classList.add(className);
    return;
  }
  document.body.classList.remove(className);
}

export function DigitScrubInput(props: DigitScrubInputProps) {
  const precision = props.precision ?? 3;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatValue(props.value, precision));
  const [hoveredDigitIndex, setHoveredDigitIndex] = useState<number | null>(null);
  const [pendingReplaceSelection, setPendingReplaceSelection] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (!editing && !draggingRef.current) {
      setDraft(formatValue(props.value, precision));
    }
  }, [props.value, precision, editing]);

  useEffect(() => {
    if (!editing || !pendingReplaceSelection || !editInputRef.current) {
      return;
    }
    const input = editInputRef.current;
    input.focus();
    input.setSelectionRange(0, input.value.length);
    setPendingReplaceSelection(false);
  }, [editing, pendingReplaceSelection]);

  const tokens = useMemo(() => tokensFromFormatted(draft), [draft]);

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isNaN(parsed)) {
      setDraft(formatValue(props.value, precision));
      return;
    }
    const next = roundToPrecision(parsed, precision);
    props.onChange(next);
    setDraft(formatValue(next, precision));
  };

  const startDigitDrag = (event: React.PointerEvent<HTMLSpanElement>, place: number) => {
    if (props.disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startValue = props.value;
    const increment = 10 ** place;
    let lastSteps = 0;
    setGlobalScrubMode(true);

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const deltaX = moveEvent.clientX - startX;
      const steps = Math.trunc(deltaX / 8);
      if (steps === lastSteps) {
        return;
      }
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        selection.removeAllRanges();
      }
      draggingRef.current = true;
      lastSteps = steps;
      const next = roundToPrecision(startValue + steps * increment, precision);
      props.onChange(next);
      setDraft(formatValue(next, precision));
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
        if (draggingRef.current) {
          suppressClickRef.current = true;
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
        upEvent.preventDefault();
        upEvent.stopPropagation();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        setGlobalScrubMode(false);
        draggingRef.current = false;
      };

      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
  };

  if (editing) {
    return (
      <input
        ref={editInputRef}
        className="widget-digit-input editing"
        type="text"
        value={draft}
        autoFocus
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false);
          commitDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setEditing(false);
            commitDraft();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
            setDraft(formatValue(props.value, precision));
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`widget-digit-input${hoveredDigitIndex !== null ? " scrub-hover" : ""}`}
      disabled={props.disabled}
      title={props.mixed ? "Mixed values" : "Drag digits to adjust place values. Click to type."}
      onClick={() => {
        if (props.disabled) {
          return;
        }
        if (suppressClickRef.current) {
          return;
        }
        setPendingReplaceSelection(true);
        setEditing(true);
      }}
      onMouseLeave={() => setHoveredDigitIndex(null)}
      onPointerDown={(event) => {
        if (hoveredDigitIndex !== null) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {props.mixed
        ? "Mixed"
        : tokens.map((token, index) => (
            <span
              key={`${token.char}-${index}`}
              className={
                token.place !== undefined
                  ? `digit${hoveredDigitIndex === index ? " hot" : ""}`
                  : "symbol"
              }
              onPointerEnter={() => {
                if (token.place !== undefined) {
                  setHoveredDigitIndex(index);
                }
              }}
              onPointerDown={
                token.place !== undefined
                  ? (event) => {
                      startDigitDrag(event, token.place as number);
                    }
                  : undefined
              }
            >
              {token.char}
            </span>
          ))}
    </button>
  );
}

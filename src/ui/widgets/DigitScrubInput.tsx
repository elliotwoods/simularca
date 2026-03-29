import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatNumberValue,
  normalizeCommittedNumber,
  parseDraftNumber
} from "@/ui/widgets/numberEditing";

interface DigitToken {
  char: string;
  place?: number;
  ghost?: boolean;
}

interface DigitScrubInputProps {
  value: number;
  mixed?: boolean;
  precision?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
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

function tokensWithGhostDigits(formatted: string, includeGhostDigits: boolean, ghostDigitCount: number): DigitToken[] {
  const base = tokensFromFormatted(formatted);
  if (!includeGhostDigits || ghostDigitCount <= 0) {
    return base;
  }
  const firstNumericIndex = base.findIndex((token) => token.place !== undefined);
  if (firstNumericIndex === -1) {
    return base;
  }
  const maxPlace = base.reduce((max, token) => {
    if (token.place === undefined) {
      return max;
    }
    return Math.max(max, token.place);
  }, 0);
  const ghosts: DigitToken[] = [];
  for (let i = maxPlace + ghostDigitCount; i > maxPlace; i -= 1) {
    ghosts.push({ char: "0", place: i, ghost: true });
  }
  return [...base.slice(0, firstNumericIndex), ...ghosts, ...base.slice(firstNumericIndex)];
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
  const [draft, setDraft] = useState(formatNumberValue(props.value, precision));
  const [hoveredPlace, setHoveredPlace] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pendingReplaceSelection, setPendingReplaceSelection] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const cleanupPendingRef = useRef<(() => void) | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const parsedDraft = useMemo(() => parseDraftNumber(draft), [draft]);
  const invalidDraft = editing && draft.trim().length > 0 && parsedDraft === null;

  useEffect(() => {
    if (!editing && !draggingRef.current) {
      setDraft(formatNumberValue(props.value, precision));
    }
  }, [editing, precision, props.value]);

  useEffect(() => {
    if (!editing || !pendingReplaceSelection || !editInputRef.current) {
      return;
    }
    const input = editInputRef.current;
    input.focus();
    input.setSelectionRange(0, input.value.length);
    setPendingReplaceSelection(false);
  }, [editing, pendingReplaceSelection]);

  useEffect(() => {
    return () => {
      cleanupPendingRef.current?.();
      cleanupDragRef.current?.();
      setGlobalScrubMode(false);
    };
  }, []);

  const tokens = useMemo(() => {
    return hovered ? tokensWithGhostDigits(draft, true, 1) : tokensFromFormatted(draft);
  }, [draft, hovered]);

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

  const cancelDraft = () => {
    setEditing(false);
    setDraft(formatNumberValue(props.value, precision));
  };

  const startDigitDrag = (place: number) => {
    if (props.disabled || !rootRef.current) {
      return;
    }
    cleanupPendingRef.current?.();
    const startValue = props.value;
    const increment = 10 ** place;
    let lastSteps = 0;
    let accumulatedDeltaX = 0;
    let lockAcquired = false;
    let ignoreInitialLockedDelta = false;
    let disposed = false;
    const root = rootRef.current;

    cleanupDragRef.current?.();

    const applyDrag = (movementX: number, moveEvent: MouseEvent) => {
      accumulatedDeltaX += movementX;
      const steps = Math.trunc(accumulatedDeltaX / 8);
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
      const rawNext = startValue + steps * increment;
      const next = normalizeCommittedNumber(rawNext, {
        min: props.min,
        max: props.max,
        step: props.step,
        precision
      });
      props.onChange(next);
      setDraft(formatNumberValue(next, precision));
    };

    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      document.removeEventListener("visibilitychange", onVisibilityChange);

      if (document.pointerLockElement === root) {
        document.exitPointerLock();
      }
      if (lockAcquired) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      setGlobalScrubMode(false);
      draggingRef.current = false;
      cleanupDragRef.current = null;
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!lockAcquired) {
        return;
      }
      const deltaX = Number.isFinite(moveEvent.movementX) ? moveEvent.movementX : 0;
      if (deltaX === 0) {
        return;
      }
      if (ignoreInitialLockedDelta) {
        // Some browsers report the pre-lock threshold movement as the first locked delta.
        ignoreInitialLockedDelta = false;
        return;
      }
      applyDrag(deltaX, moveEvent);
    };

    const onMouseUp = () => {
      cleanup();
    };

    const onBlur = () => {
      cleanup();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        cleanup();
      }
    };

    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") {
        return;
      }
      keyboardEvent.preventDefault();
      cleanup();
    };

    const onPointerLockChange = () => {
      if (document.pointerLockElement === root) {
        lockAcquired = true;
        ignoreInitialLockedDelta = true;
        draggingRef.current = true;
        setGlobalScrubMode(true);
        return;
      }
      cleanup();
    };

    const onPointerLockError = () => {
      cleanup();
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp, { passive: false });
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);
    document.addEventListener("visibilitychange", onVisibilityChange);

    try {
      const lockResult = root.requestPointerLock();
      if (lockResult && typeof (lockResult as Promise<void>).catch === "function") {
        void (lockResult as Promise<void>).catch(() => {
          cleanup();
        });
      }
    } catch {
      cleanup();
    }
  };

  const startPendingDigitDrag = (event: React.PointerEvent<HTMLSpanElement>, place: number) => {
    if (props.disabled) {
      return;
    }
    cleanupPendingRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let disposed = false;

    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      cleanupPendingRef.current = null;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      if (Math.abs(moveEvent.clientX - startX) <= 3) {
        return;
      }
      cleanup();
      startDigitDrag(place);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
      cleanup();
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) {
        return;
      }
      cleanup();
    };

    cleanupPendingRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  if (editing) {
    return (
      <span className={`widget-buffered-number${invalidDraft ? " is-invalid" : ""}`}>
        <input
          ref={editInputRef}
          className={`widget-digit-input editing${props.className ? ` ${props.className}` : ""}`}
          type="text"
          value={draft}
          autoFocus
          disabled={props.disabled}
          aria-invalid={invalidDraft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (skipBlurCommitRef.current) {
              skipBlurCommitRef.current = false;
              return;
            }
            commitDraft();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              skipBlurCommitRef.current = true;
              cancelDraft();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const factor = event.shiftKey ? 10 : 1;
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const baseStep = props.step ?? Math.max(10 ** -precision, 0.0001);
              const next = normalizeCommittedNumber(props.value + direction * baseStep * factor, {
                min: props.min,
                max: props.max,
                step: props.step,
                precision
              });
              props.onChange(next);
              setDraft(formatNumberValue(next, precision));
            }
          }}
        />
        {invalidDraft ? (
          <span className="widget-buffered-number-indicator" aria-hidden="true" title="Invalid number">
            !
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      ref={rootRef}
      type="button"
      className={`widget-digit-input${hoveredPlace !== null ? " scrub-hover" : ""}${props.className ? ` ${props.className}` : ""}`}
      disabled={props.disabled}
      title={props.mixed ? "Mixed values" : "Drag digits to adjust place values. Click to type."}
      onClick={() => {
        if (props.disabled || suppressClickRef.current) {
          return;
        }
        setPendingReplaceSelection(true);
        setEditing(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setHoveredPlace(null);
      }}
    >
      {props.mixed
        ? "Mixed"
        : tokens.map((token, index) => (
            <span
              key={`${token.char}-${token.place ?? "sym"}-${index}`}
              className={
                token.place !== undefined
                  ? `digit${token.ghost ? " ghost" : ""}${hoveredPlace === token.place ? " hot" : ""}`
                  : "symbol"
              }
              onPointerEnter={() => {
                if (token.place !== undefined) {
                  setHoveredPlace(token.place);
                }
              }}
              onPointerDown={
                token.place !== undefined
                  ? (event) => {
                      startPendingDigitDrag(event, token.place as number);
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

import { useEffect, useMemo, useRef, useState } from "react";

interface DigitToken {
  char: string;
  place?: number;
  ghost?: boolean;
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
  const [hoveredPlace, setHoveredPlace] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pendingReplaceSelection, setPendingReplaceSelection] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [maxVisibleChars, setMaxVisibleChars] = useState<number | null>(null);
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

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
      setGlobalScrubMode(false);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const measure = () => {
      const style = window.getComputedStyle(root);
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(style.paddingRight) || 0;
      const contentWidth = Math.max(1, root.clientWidth - paddingLeft - paddingRight);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        setMaxVisibleChars(Math.max(1, Math.floor(contentWidth / 8)));
        return;
      }
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const charWidth = Math.max(1, context.measureText("0").width);
      setMaxVisibleChars(Math.max(1, Math.floor(contentWidth / charWidth)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  const tokens = useMemo(() => tokensWithGhostDigits(draft, hovered, 1), [draft, hovered]);
  const visibleTokenIndexes = useMemo(() => {
    if (maxVisibleChars === null || tokens.length <= maxVisibleChars) {
      return new Set(tokens.map((_, index) => index));
    }
    const hidden = new Set<number>();
    const decimalIndex = tokens.findIndex((token) => token.char === ".");
    let visibleCount = tokens.length;

    for (let index = tokens.length - 1; index >= 0 && visibleCount > maxVisibleChars; index -= 1) {
      const token = tokens[index];
      if (!token) {
        continue;
      }
      if (decimalIndex !== -1 && index <= decimalIndex) {
        break;
      }
      if (token.ghost) {
        continue;
      }
      hidden.add(index);
      visibleCount -= 1;
    }

    if (decimalIndex !== -1 && visibleCount > maxVisibleChars && !hidden.has(decimalIndex)) {
      hidden.add(decimalIndex);
      visibleCount -= 1;
    }

    for (let index = tokens.length - 1; index >= 0 && visibleCount > maxVisibleChars; index -= 1) {
      if (hidden.has(index)) {
        continue;
      }
      const token = tokens[index];
      if (!token) {
        continue;
      }
      if (token.ghost) {
        continue;
      }
      hidden.add(index);
      visibleCount -= 1;
    }

    return new Set(tokens.map((_, index) => index).filter((index) => !hidden.has(index)));
  }, [tokens, maxVisibleChars]);

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
    if (!rootRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startValue = props.value;
    const increment = 10 ** place;
    let lastSteps = 0;
    let accumulatedDeltaX = 0;
    let lockAcquired = false;
    let didAdjustValue = false;
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
      const next = roundToPrecision(startValue + steps * increment, precision);
      props.onChange(next);
      setDraft(formatValue(next, precision));
      if (next !== startValue) {
        didAdjustValue = true;
      }
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
      if (lockAcquired && didAdjustValue) {
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
      ref={rootRef}
      type="button"
      className={`widget-digit-input${hoveredPlace !== null ? " scrub-hover" : ""}`}
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setHoveredPlace(null);
      }}
      onPointerDown={(event) => {
        if (hoveredPlace !== null) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {props.mixed
        ? "Mixed"
        : tokens.map((token, index) => (
            <span
              key={`${token.char}-${token.place ?? "sym"}-${index}`}
              style={visibleTokenIndexes.has(index) ? undefined : { display: "none" }}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface NumberFieldProps {
  label: string;
  description?: string;
  value: number;
  mixed?: boolean;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  dragSpeed?: number;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: number) => void;
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) {
    next = Math.max(min, next);
  }
  if (max !== undefined) {
    next = Math.min(max, next);
  }
  return next;
}

function applyStep(value: number, step?: number, min?: number): number {
  if (!step || step <= 0) {
    return value;
  }
  const base = min ?? 0;
  const snapped = Math.round((value - base) / step) * step + base;
  return Number(snapped.toFixed(8));
}

function normalizeValue(value: number, options: { min?: number; max?: number; step?: number }): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return clamp(applyStep(value, options.step, options.min), options.min, options.max);
}

function formatValue(value: number, precision?: number): string {
  if (precision !== undefined && precision >= 0) {
    return value.toFixed(precision);
  }
  return Number(value.toFixed(6)).toString();
}

export function NumberField(props: NumberFieldProps) {
  const [draft, setDraft] = useState(() => formatValue(props.value, props.precision));
  const [editing, setEditing] = useState(false);
  const suppressClickRef = useRef(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!editing && !draggingRef.current) {
      setDraft(formatValue(props.value, props.precision));
    }
  }, [props.value, props.precision, editing]);

  const hasRange = props.min !== undefined && props.max !== undefined;

  const sliderStep = useMemo(() => {
    if (props.step && props.step > 0) {
      return props.step;
    }
    if (hasRange) {
      const span = Math.abs((props.max as number) - (props.min as number));
      return Number(Math.max(span / 250, 0.0001).toFixed(6));
    }
    return 0.01;
  }, [props.max, props.min, props.step, hasRange]);

  const commitDraft = useCallback(() => {
    const parsed = Number.parseFloat(draft);
    if (Number.isNaN(parsed)) {
      setDraft(formatValue(props.value, props.precision));
      return;
    }
    const next = normalizeValue(parsed, {
      min: props.min,
      max: props.max,
      step: props.step
    });
    props.onChange(next);
    setDraft(formatValue(next, props.precision));
  }, [draft, props]);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLInputElement>) => {
      if (props.disabled) {
        return;
      }
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startValue = props.value;
      draggingRef.current = false;

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        const delta = moveEvent.clientX - startX;
        if (!draggingRef.current && Math.abs(delta) > 2) {
          draggingRef.current = true;
          setEditing(false);
        }
        if (!draggingRef.current) {
          return;
        }

        moveEvent.preventDefault();
        const autoSpeed =
          props.step ??
          (hasRange
            ? Math.max(Math.abs((props.max as number) - (props.min as number)) / 400, 0.0001)
            : Math.max(Math.abs(startValue) / 200, 0.01));
        const speed = props.dragSpeed ?? autoSpeed;
        const next = normalizeValue(startValue + delta * speed, {
          min: props.min,
          max: props.max,
          step: props.step
        });
        props.onChange(next);
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
        draggingRef.current = false;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp);
    },
    [props, hasRange]
  );

  const progressPercent = hasRange
    ? Math.max(
        0,
        Math.min(100, ((props.value - (props.min as number)) / ((props.max as number) - (props.min as number))) * 100)
      )
    : 0;

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={props.disabled}
    >
      <div className="widget-number">
        {hasRange ? (
          <input
            className="widget-number-slider"
            type="range"
            min={props.min}
            max={props.max}
            step={sliderStep}
            value={props.value}
            disabled={props.disabled}
            style={{ ["--fill" as string]: `${progressPercent}%` }}
            onChange={(event) => {
              const next = normalizeValue(Number(event.target.value), {
                min: props.min,
                max: props.max,
                step: props.step
              });
              props.onChange(next);
            }}
          />
        ) : null}
        <div className="widget-number-input-wrap">
          <input
            className="widget-number-input"
            value={props.mixed && !editing ? "" : draft}
            placeholder={props.mixed ? "Mixed" : undefined}
            disabled={props.disabled}
            onPointerDown={handleDragStart}
            onClick={(event) => {
              if (suppressClickRef.current) {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              commitDraft();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
                (event.target as HTMLInputElement).blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(formatValue(props.value, props.precision));
                (event.target as HTMLInputElement).blur();
              }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const factor = event.shiftKey ? 10 : 1;
                const stepValue = (props.step ?? sliderStep) * factor;
                const direction = event.key === "ArrowUp" ? 1 : -1;
                const next = normalizeValue(props.value + direction * stepValue, {
                  min: props.min,
                  max: props.max,
                  step: props.step
                });
                props.onChange(next);
              }
            }}
          />
          {props.unit ? <span className="widget-number-unit">{props.unit}</span> : null}
        </div>
      </div>
    </InspectorFieldRow>
  );
}

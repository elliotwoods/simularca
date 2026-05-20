import { useEffect, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface ColorFieldProps {
  label: string;
  description?: string;
  value: string;
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  /** When true, the value is an 8-digit `#RRGGBBAA` and a sibling alpha slider
   *  is rendered (the native `<input type="color">` is RGB-only). */
  alpha?: boolean;
  onChange: (value: string) => void;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;
const HEX8 = /^#[0-9a-fA-F]{8}$/;

function normalizeHexColor(value: string, fallback = "#000000"): string {
  const trimmed = value.trim();
  if (HEX6.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (HEX8.test(trimmed)) {
    // strip alpha for native color input consumers
    return trimmed.slice(0, 7).toLowerCase();
  }
  if (HEX3.test(trimmed)) {
    const r = trimmed[1] ?? "0";
    const g = trimmed[2] ?? "0";
    const b = trimmed[3] ?? "0";
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function extractAlpha(value: string, fallback = 255): number {
  const trimmed = value.trim();
  if (HEX8.test(trimmed)) {
    return Number.parseInt(trimmed.slice(7, 9), 16);
  }
  return fallback;
}

function alphaByte(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, "0");
}

export function ColorField(props: ColorFieldProps) {
  const [draft, setDraft] = useState(props.value);

  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const safeColor = normalizeHexColor(props.value, "#000000");
  const alphaEnabled = props.alpha === true;
  const alpha = extractAlpha(props.value, 255);

  const emit = (rgb: string, a: number) => {
    if (alphaEnabled) {
      const next = `${rgb}${alphaByte(a)}`;
      setDraft(next);
      props.onChange(next);
    } else {
      setDraft(rgb);
      props.onChange(rgb);
    }
  };

  const acceptText = (next: string): boolean => {
    if (alphaEnabled) {
      return HEX8.test(next) || HEX6.test(next) || HEX3.test(next);
    }
    return HEX6.test(next) || HEX3.test(next);
  };

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={props.disabled}
    >
      <div className="inspector-scene-color-row">
        <input
          type="color"
          className="inspector-color-input"
          value={safeColor}
          disabled={props.disabled}
          onChange={(event) => emit(event.target.value, alpha)}
        />
        {alphaEnabled ? (
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            className="inspector-color-alpha"
            value={alpha}
            disabled={props.disabled}
            title={`Alpha ${alpha}/255`}
            onChange={(event) =>
              emit(safeColor, Number.parseInt(event.target.value, 10))
            }
          />
        ) : null}
        <input
          type="text"
          className="widget-text"
          value={props.mixed ? "" : draft}
          placeholder={props.mixed ? "Mixed" : undefined}
          disabled={props.disabled}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (acceptText(next)) {
              props.onChange(next);
            }
          }}
        />
      </div>
    </InspectorFieldRow>
  );
}

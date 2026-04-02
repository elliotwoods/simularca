import { formatNumberValue, inferDisplayPrecision, normalizeCommittedNumber } from "@/ui/widgets/numberEditing";
import { inferQuantizedStepCount, normalizeValue, padRotoBankSlots, shortenRotoLabel } from "@/features/rotoControl/utils";
import type { RotoControlBank, RotoControlColorRole, RotoControlSlot } from "@/types/ipc";

const ROTO_EMPTY_LABEL = " ";

export interface RotoBinding {
  slot: RotoControlSlot;
  onTurn?: (delta: number) => void;
  onSetNormalized?: (normalized: number) => void;
  onPress?: () => void;
}

export interface RotoNumberControl {
  id: string;
  label: string;
  colorRole: RotoControlColorRole;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  centered?: boolean;
  disabled?: boolean;
  onChange: (next: number) => void;
}

interface RotoBooleanBindingOptions {
  trueText?: string;
  falseText?: string;
}

interface RotoEnumBindingOptions {
  valueText?: (value: string) => string;
  stepLabels?: string[];
}

function titleCaseWords(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export function createRotoActionBinding(
  id: string,
  label: string,
  colorRole: RotoControlColorRole,
  onPress?: () => void,
  valueText?: string,
  disabled = false
): RotoBinding {
  return {
    slot: {
      id,
      label: shortenRotoLabel(label),
      kind: "action",
      colorRole,
      valueText,
      disabled
    },
    onPress: disabled ? undefined : onPress
  };
}

export function createRotoDisplayBinding(
  id: string,
  label: string,
  valueText?: string,
  colorRole: RotoControlColorRole = "default"
): RotoBinding {
  return createRotoActionBinding(id, label, colorRole, undefined, valueText, true);
}

export function createRotoBooleanBinding(
  id: string,
  label: string,
  checked: boolean,
  onChange: (next: boolean) => void,
  colorRole: RotoControlColorRole = "toggle",
  disabled = false,
  options: RotoBooleanBindingOptions = {}
): RotoBinding {
  return {
    slot: {
      id,
      label: shortenRotoLabel(label),
      kind: "bool",
      colorRole,
      valueText: checked ? (options.trueText ?? "Enabled") : (options.falseText ?? "Disabled"),
      normalizedValue: checked ? 1 : 0,
      quantizedStepCount: 2,
      disabled
    },
    onTurn: (delta) => {
      if (disabled || delta === 0) {
        return;
      }
      onChange(delta > 0);
    },
    onSetNormalized: (normalized) => {
      if (!disabled) {
        onChange(normalized >= 0.5);
      }
    },
    onPress: () => {
      if (!disabled) {
        onChange(!checked);
      }
    }
  };
}

export function createRotoEnumBinding(
  id: string,
  label: string,
  options: string[],
  currentValue: string,
  onChange: (next: string) => void,
  colorRole: RotoControlColorRole = "enum",
  disabled = false,
  bindingOptions: RotoEnumBindingOptions = {}
): RotoBinding {
  const currentIndex = Math.max(0, options.indexOf(currentValue));
  return {
    slot: {
      id,
      label: shortenRotoLabel(label),
      kind: "enum",
      colorRole,
      valueText: bindingOptions.valueText ? bindingOptions.valueText(currentValue) : titleCaseWords(currentValue),
      normalizedValue: options.length > 1 ? currentIndex / (options.length - 1) : 0,
      stepLabels:
        options.length <= 10
          ? (bindingOptions.stepLabels ?? options).slice(0, options.length).map((option) => shortenRotoLabel(option))
          : undefined,
      quantizedStepCount: Math.max(2, Math.min(18, options.length)),
      disabled
    },
    onTurn: (delta) => {
      if (disabled || delta === 0 || options.length === 0) {
        return;
      }
      const nextIndex = Math.max(0, Math.min(options.length - 1, currentIndex + Math.trunc(delta)));
      const next = options[nextIndex];
      if (next) {
        onChange(next);
      }
    },
    onSetNormalized: (normalized) => {
      if (disabled || options.length === 0) {
        return;
      }
      const nextIndex =
        options.length <= 1 ? 0 : Math.max(0, Math.min(options.length - 1, Math.round(normalized * (options.length - 1))));
      const next = options[nextIndex];
      if (next) {
        onChange(next);
      }
    },
    onPress: () => {
      if (disabled || options.length <= 1) {
        return;
      }
      const next = options[(currentIndex + 1) % options.length];
      if (next) {
        onChange(next);
      }
    }
  };
}

export function createRotoNumberBinding(
  control: RotoNumberControl,
  enterZoom?: (control: RotoNumberControl) => void
): RotoBinding {
  const displayPrecision = inferDisplayPrecision(control.precision, control.step);
  const turnStep =
    (typeof control.step === "number" && control.step > 0 ? control.step : undefined) ??
    (typeof control.min === "number" && typeof control.max === "number" && control.max > control.min
      ? Math.max((control.max - control.min) / 250, 0.0001)
      : Math.pow(10, -(displayPrecision ?? 2)));
  const hasRange = typeof control.min === "number" && typeof control.max === "number" && control.max > control.min;
  const absoluteValueFromNormalized = (normalized: number): number => {
    if (!hasRange || typeof control.min !== "number" || typeof control.max !== "number") {
      return control.value;
    }
    const next = control.min + Math.max(0, Math.min(1, normalized)) * (control.max - control.min);
    return normalizeCommittedNumber(next, {
      min: control.min,
      max: control.max,
      step: control.step,
      precision: displayPrecision
    });
  };
  return {
    slot: {
      id: control.id,
      label: shortenRotoLabel(control.label),
      kind: "number",
      colorRole: control.colorRole,
      valueText: formatNumberValue(control.value, displayPrecision),
      normalizedValue: normalizeValue(control.value, control.min, control.max),
      min: control.min,
      max: control.max,
      step: control.step,
      precision: displayPrecision,
      unit: control.unit,
      centered: control.centered,
      quantizedStepCount: inferQuantizedStepCount(control.min, control.max, control.step),
      disabled: control.disabled
    },
    onTurn: (delta) => {
      if (control.disabled || delta === 0) {
        return;
      }
      const next = normalizeCommittedNumber(control.value + delta * turnStep, {
        min: control.min,
        max: control.max,
        step: control.step,
        precision: displayPrecision
      });
      control.onChange(next);
    },
    onSetNormalized: hasRange
      ? (normalized) => {
        if (!control.disabled) {
          control.onChange(absoluteValueFromNormalized(normalized));
        }
      }
      : undefined,
    onPress: () => {
      if (!control.disabled && !hasRange && enterZoom) {
        enterZoom(control);
      }
    }
  };
}

function emptyRotoBinding(index: number): RotoBinding {
  return {
    slot: {
      id: `empty-${index}`,
      label: ROTO_EMPTY_LABEL,
      kind: "action",
      colorRole: "default",
      disabled: true
    }
  };
}

function padBindingsToFullPages(bindings: RotoBinding[], pageCount: number): RotoBinding[] {
  const padded = bindings.slice();
  while (padded.length < pageCount * 8) {
    padded.push(emptyRotoBinding(padded.length));
  }
  return padded;
}

export function buildRotoBank(
  title: string,
  contextPath: string,
  pageIndex: number,
  bindings: RotoBinding[],
  zoomTargetSlotId?: string | null
): { bank: RotoControlBank; pageCount: number; pageBindings: RotoBinding[] } {
  const pageCount = Math.max(1, Math.ceil(bindings.length / 8));
  const safePageIndex = Math.max(0, Math.min(pageCount - 1, pageIndex));
  const allBindings = padBindingsToFullPages(bindings, pageCount);
  const pageBindings = padRotoBankSlots(
    allBindings.slice(safePageIndex * 8, safePageIndex * 8 + 8),
    (index) => emptyRotoBinding(index)
  );
  return {
    bank: {
      title: shortenRotoLabel(title),
      contextPath,
      pageIndex: safePageIndex,
      pageCount,
      slots: pageBindings.map((binding) => binding.slot),
      allSlots: allBindings.map((binding) => binding.slot),
      zoomTargetSlotId: zoomTargetSlotId ?? null
    },
    pageCount,
    pageBindings
  };
}

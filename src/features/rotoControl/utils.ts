import type { RotoControlBank, RotoControlColorRole } from "@/types/ipc";

function splitWords(label: string): string[] {
  return label
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function shortenRotoLabel(label: string, maxVisible = 12): string {
  const ascii = label.replace(/[^\x20-\x7E]/g, "");
  const words = splitWords(ascii).slice(0, 3);
  if (words.length === 0) {
    return "Param";
  }
  const separatorBudget = Math.max(0, words.length - 1);
  const visibleBudget = Math.max(1, maxVisible - separatorBudget);
  const baseBudget = Math.floor(visibleBudget / words.length);
  let remainder = visibleBudget - baseBudget * words.length;
  const parts = words.map((word) => {
    const allocation = baseBudget + (remainder-- > 0 ? 1 : 0);
    if (word.length <= allocation) {
      return word;
    }
    return word.slice(0, allocation);
  });
  return parts.join(" ").slice(0, maxVisible) || "Param";
}

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeValue(
  value: number,
  min?: number,
  max?: number
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (typeof min === "number" && typeof max === "number" && max > min) {
    return clampNormalized((value - min) / (max - min));
  }
  return undefined;
}

export function inferQuantizedStepCount(min?: number, max?: number, step?: number): number | undefined {
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof step !== "number" ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(step) ||
    step <= 0 ||
    max <= min
  ) {
    return undefined;
  }
  const count = Math.floor((max - min) / step + 0.000001) + 1;
  if (count < 2) {
    return undefined;
  }
  return Math.max(2, Math.min(18, count));
}

export function rotoColorScheme(role: RotoControlColorRole): number {
  switch (role) {
    case "translate":
      return 1;
    case "rotate":
      return 2;
    case "scale":
      return 3;
    case "enum":
      return 4;
    case "toggle":
      return 5;
    case "drill":
      return 6;
    case "action":
      return 7;
    case "zoom":
      return 8;
    default:
      return 0;
  }
}

export function padRotoBankSlots<T>(slots: T[], fillFactory: (index: number) => T): T[] {
  const next = slots.slice(0, 8);
  while (next.length < 8) {
    next.push(fillFactory(next.length));
  }
  return next;
}

export function equalRotoBanks(a: RotoControlBank | null, b: RotoControlBank | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

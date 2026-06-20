export interface NumberEditConstraints {
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}

export function clampNumber(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) {
    next = Math.max(min, next);
  }
  if (max !== undefined) {
    next = Math.min(max, next);
  }
  return next;
}

export function snapNumberToStep(value: number, step?: number, min?: number): number {
  if (!step || step <= 0) {
    return value;
  }
  const base = min ?? 0;
  const snapped = Math.round((value - base) / step) * step + base;
  return Number(snapped.toFixed(8));
}

export function roundNumberToPrecision(value: number, precision?: number): number {
  if (precision === undefined || precision < 0) {
    return value;
  }
  return Number(value.toFixed(precision));
}

export function normalizeCommittedNumber(value: number, constraints: NumberEditConstraints): number {
  const clamped = clampNumber(value, constraints.min, constraints.max);
  const stepped = snapNumberToStep(clamped, constraints.step, constraints.min);
  const reclamped = clampNumber(stepped, constraints.min, constraints.max);
  return roundNumberToPrecision(reclamped, constraints.precision);
}

export function formatNumberValue(value: number, precision?: number): string {
  if (!Number.isFinite(value)) {
    const fallbackPrecision = precision !== undefined && precision >= 0 ? precision : 0;
    return (0).toFixed(fallbackPrecision);
  }
  if (precision !== undefined && precision >= 0) {
    return value.toFixed(precision);
  }
  return Number(value.toFixed(6)).toString();
}

export function inferDisplayPrecision(precision?: number, step?: number): number | undefined {
  if (precision !== undefined && precision >= 0) {
    return precision;
  }
  if (!step || !Number.isFinite(step)) {
    return undefined;
  }
  const normalized = Math.abs(step);
  if (normalized >= 1) {
    return 0;
  }
  const asText = normalized.toString();
  const scientificMatch = asText.match(/e-(\d+)$/i);
  if (scientificMatch) {
    const exponent = Number.parseInt(scientificMatch[1] ?? "0", 10);
    return Number.isFinite(exponent) ? exponent : undefined;
  }
  const decimalIndex = asText.indexOf(".");
  if (decimalIndex === -1) {
    return undefined;
  }
  return asText.length - decimalIndex - 1;
}

const MAX_EXPRESSION_LENGTH = 256;

/**
 * Evaluate a text formula (a JS expression) to a finite number, or null.
 *
 * Common math helpers and constants are exposed in scope so expressions like
 * `sqrt(2)`, `pi * 3`, or `max(1, 2)` work in addition to `Math.sqrt(2)`.
 * Anything that throws, returns a non-number, or returns a non-finite value
 * yields null.
 */
export function evaluateNumberExpression(source: string): number | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_EXPRESSION_LENGTH) {
    return null;
  }
  try {
    const evaluator = new Function(
      `'use strict';` +
        `const { abs, sqrt, cbrt, sign, sin, cos, tan, asin, acos, atan, atan2, min, max, round, floor, ceil, trunc, pow, log, log2, log10, exp, hypot } = Math;` +
        `const pi = Math.PI; const e = Math.E; const tau = Math.PI * 2;` +
        `return (${trimmed});`
    );
    const result = evaluator();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function parseDraftNumber(draft: string): number | null {
  const trimmed = draft.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return evaluateNumberExpression(trimmed);
}

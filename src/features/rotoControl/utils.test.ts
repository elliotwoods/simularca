import { describe, expect, it } from "vitest";
import { inferQuantizedStepCount, normalizeValue, shortenRotoLabel } from "@/features/rotoControl/utils";

describe("roto control utils", () => {
  it("shortens labels within the controller budget", () => {
    expect(shortenRotoLabel("Camera Navigation Speed", 12).length).toBeLessThanOrEqual(12);
    expect(shortenRotoLabel("Translate X", 12)).toBe("Transl X");
  });

  it("normalizes ranged numeric values", () => {
    expect(normalizeValue(5, 0, 10)).toBe(0.5);
    expect(normalizeValue(-10, 0, 10)).toBe(0);
    expect(normalizeValue(100, 0, 10)).toBe(1);
    expect(normalizeValue(3)).toBeUndefined();
  });

  it("infers quantized step counts from numeric constraints", () => {
    expect(inferQuantizedStepCount(0, 1, 0.25)).toBe(5);
    expect(inferQuantizedStepCount(0, 100, 1)).toBe(18);
    expect(inferQuantizedStepCount(undefined, 1, 0.1)).toBeUndefined();
  });
});

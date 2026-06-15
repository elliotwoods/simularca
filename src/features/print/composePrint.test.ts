import { describe, expect, it } from "vitest";
import { invertHex } from "@/features/print/composePrint";

describe("invertHex", () => {
  it("inverts rgb channels, leaving the format intact", () => {
    expect(invertHex("#000000")).toBe("#ffffff");
    expect(invertHex("#ffffff")).toBe("#000000");
    // Grid defaults flip to their complements.
    expect(invertHex("#2f8f9d")).toBe("#d07062");
    expect(invertHex("#1f2430")).toBe("#e0dbcf");
  });

  it("accepts hex without a leading hash", () => {
    expect(invertHex("000000")).toBe("#ffffff");
  });

  it("returns the input unchanged for non-#rrggbb strings", () => {
    expect(invertHex("rgba(0,0,0,1)")).toBe("rgba(0,0,0,1)");
    expect(invertHex("#abc")).toBe("#abc");
  });
});

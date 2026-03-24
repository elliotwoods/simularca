import { describe, expect, it } from "vitest";
import { assertViewportScreenshotSize, formatViewportScreenshotStatus } from "@/features/render/viewportScreenshot";

describe("viewportScreenshot helpers", () => {
  it("rounds and returns a valid viewport size", () => {
    expect(assertViewportScreenshotSize(1279.6, 719.4)).toEqual({
      width: 1280,
      height: 719
    });
  });

  it("rejects zero-sized screenshots", () => {
    expect(() => assertViewportScreenshotSize(0, 240)).toThrow("Viewport screenshot is unavailable");
    expect(() => assertViewportScreenshotSize(320, 0)).toThrow("Viewport screenshot is unavailable");
  });

  it("formats a success status message with backend details", () => {
    expect(
      formatViewportScreenshotStatus({
        width: 2560,
        height: 1440,
        backend: "webgpu"
      })
    ).toBe("Viewport screenshot copied to clipboard. 2560 x 1440 PNG | WEBGPU | debug views hidden.");
  });
});

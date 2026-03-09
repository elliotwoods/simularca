import { describe, expect, it } from "vitest";
import {
  defaultRenderCameraPathId,
  detectResolutionPreset,
  findRenderCameraPath,
  resolveRenderDurationSeconds
} from "@/features/render/settings";

describe("render settings helpers", () => {
  it("detects known resolution presets and falls back to custom", () => {
    expect(detectResolutionPreset(1920, 1080)).toBe("fhd");
    expect(detectResolutionPreset(3840, 2160)).toBe("4k");
    expect(detectResolutionPreset(1234, 567)).toBe("custom");
  });

  it("defaults to the first camera path when present", () => {
    expect(
      defaultRenderCameraPathId([
        { id: "cam-a", label: "A", durationSeconds: 5 },
        { id: "cam-b", label: "B", durationSeconds: 7 }
      ])
    ).toBe("cam-a");
    expect(defaultRenderCameraPathId([])).toBe("");
  });

  it("resolves render duration from the selected camera path", () => {
    const cameraPaths = [
      { id: "cam-a", label: "A", durationSeconds: 12.5 },
      { id: "cam-b", label: "B", durationSeconds: 4.25 }
    ];
    expect(findRenderCameraPath(cameraPaths, "cam-b")?.label).toBe("B");
    expect(
      resolveRenderDurationSeconds(
        {
          durationSeconds: 99,
          cameraPathId: "cam-a"
        },
        cameraPaths
      )
    ).toBe(12.5);
    expect(
      resolveRenderDurationSeconds(
        {
          durationSeconds: 99,
          cameraPathId: ""
        },
        cameraPaths
      )
    ).toBe(99);
  });
});

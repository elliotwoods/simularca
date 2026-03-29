import { describe, expect, it, vi } from "vitest";
import { resolveDroppedFileSourcePath } from "@/app/dragDropFilePath";

describe("resolveDroppedFileSourcePath", () => {
  it("prefers the Electron getPathForFile bridge when available", () => {
    const file = { path: "C:/legacy/plot.dxf" } as File & { path: string };
    const electronApi = {
      getPathForFile: vi.fn(() => "C:/electron/plot.dxf")
    };

    expect(resolveDroppedFileSourcePath(file, electronApi)).toBe("C:/electron/plot.dxf");
    expect(electronApi.getPathForFile).toHaveBeenCalledWith(file);
  });

  it("falls back to the legacy file.path field", () => {
    const file = { path: "C:/legacy/plot.dxf" } as File & { path: string };

    expect(resolveDroppedFileSourcePath(file)).toBe("C:/legacy/plot.dxf");
  });

  it("returns null when neither Electron nor the dropped file provides a path", () => {
    const file = {} as File;
    const electronApi = {
      getPathForFile: vi.fn(() => null)
    };

    expect(resolveDroppedFileSourcePath(file, electronApi)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  formatSceneColorBufferStatusLabel,
  getWebGlColorBufferSupport,
  resolveSceneColorBufferPrecision,
  sceneColorBufferPrecisionLabel
} from "@/render/colorBufferPrecision";

describe("resolveSceneColorBufferPrecision", () => {
  it("keeps float32 when supported", () => {
    const resolved = resolveSceneColorBufferPrecision(
      "float32",
      { float32: true, float16: true, uint8: true },
      "webgl2",
      {
        requestedAntialiasing: true
      }
    );

    expect(resolved.activePrecision).toBe("float32");
    expect(resolved.formatLabel).toBe("RGBA32F");
    expect(resolved.statusFormatLabel).toBe("WebGL2 RGBA32F");
    expect(resolved.activeAntialiasing).toBe(true);
    expect(resolved.warningMessage).toBeNull();
  });

  it("falls back from float32 to float16 before uint8", () => {
    const resolved = resolveSceneColorBufferPrecision(
      "float32",
      { float32: false, float16: true, uint8: true },
      "webgl2",
      {
        requestedAntialiasing: true
      }
    );

    expect(resolved.activePrecision).toBe("float16");
    expect(resolved.formatLabel).toBe("RGBA16F");
    expect(resolved.warningMessage).toBe(
      "Requested Float32 HDR but fell back to Float16 HDR."
    );
  });

  it("falls back to uint8 when no float render targets are available", () => {
    const resolved = resolveSceneColorBufferPrecision(
      "float32",
      { float32: false, float16: false, uint8: true },
      "webgl2",
      {
        requestedAntialiasing: true
      }
    );

    expect(resolved.activePrecision).toBe("uint8");
    expect(resolved.statusFormatLabel).toBe("WebGL2 RGBA8");
  });

  it("keeps float32 on WebGPU but disables MSAA when requested", () => {
    const resolved = resolveSceneColorBufferPrecision(
      "float32",
      { float32: true, float16: true, uint8: true },
      "webgpu",
      {
        requestedAntialiasing: true
      }
    );

    expect(resolved.activePrecision).toBe("float32");
    expect(resolved.requestedAntialiasing).toBe(true);
    expect(resolved.activeAntialiasing).toBe(false);
    expect(resolved.warningMessage).toBe(
      "WebGPU Float32 HDR disables MSAA; rendering without antialiasing."
    );
  });

  it("keeps MSAA enabled for WebGPU float16", () => {
    const resolved = resolveSceneColorBufferPrecision(
      "float16",
      { float32: true, float16: true, uint8: true },
      "webgpu",
      {
        requestedAntialiasing: true
      }
    );

    expect(resolved.activePrecision).toBe("float16");
    expect(resolved.activeAntialiasing).toBe(true);
    expect(resolved.warningMessage).toBeNull();
  });
});

describe("color buffer precision helpers", () => {
  it("formats readable precision and backend labels", () => {
    expect(sceneColorBufferPrecisionLabel("float16")).toBe("Float16 HDR");
    expect(formatSceneColorBufferStatusLabel("webgpu", "float32")).toBe("WebGPU RGBA32F");
  });

  it("detects WebGL float render target support from EXT_color_buffer_float", () => {
    const support = getWebGlColorBufferSupport({
      capabilities: { isWebGL2: true },
      extensions: {
        has: (name: string) => name === "EXT_color_buffer_float"
      }
    });

    expect(support).toEqual({
      float32: true,
      float16: true,
      uint8: true
    });
  });
});

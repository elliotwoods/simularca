import { useCallback, useEffect, useRef, useState } from "react";
import { configureCanvasForHdr } from "@/render/hdrSupport";
import {
  HDR_HISTOGRAM_BINS,
  HDR_HISTOGRAM_MAX,
  subscribeHdrHistogram,
  type HdrHistogramResult
} from "@/features/render/hdrHistogramBridge";

// Maximum luminance multiplier shown across the horizontal axis (1.0 = SDR reference
// white / paper white). Shared with the histogram so both views use the same 0–4× scale.
const MAX_MULTIPLIER = HDR_HISTOGRAM_MAX;

type HdrPreviewStatus = "init" | "hdr" | "sdr" | "unsupported" | "error";

// Fullscreen-triangle vertex shader + a fragment shader that paints horizontal test
// bands. The horizontal axis is a linear luminance multiplier in [0, MAX]; each channel
// is written through the sRGB OETF (which extends monotonically past 1.0), so on an
// extended-range / Display-P3 canvas the region past the 1x marker lands in HDR
// territory. On an SDR canvas those values clamp to white instead.
const SHADER = /* wgsl */ `
const MAX: f32 = ${MAX_MULTIPLIER.toFixed(1)};
const BANDS: f32 = 6.0;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  // uv origin bottom-left, range [0,1].
  out.uv = 0.5 * (p[i] + vec2f(1.0, 1.0));
  return out;
}

// sRGB / Display-P3 opto-electronic transfer function, valid (monotonic) for L > 1.
fn enc(L: f32) -> f32 {
  let l = max(L, 0.0);
  if (l <= 0.0031308) {
    return 12.92 * l;
  }
  return 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let x = in.uv.x;            // 0 (left) .. 1 (right)
  let y = 1.0 - in.uv.y;      // 0 (top) .. 1 (bottom)
  let L = x * MAX;            // linear luminance multiplier

  let bandF = y * BANDS;
  let band = floor(bandF);

  var color = vec3f(0.0);
  if (band < 0.5) {
    // Neutral smooth ramp.
    color = vec3f(enc(L));
  } else if (band < 1.5) {
    // Stepped neutral stops (0.5x staircase) to judge discrete brightness levels.
    let Lq = floor(L / 0.5) * 0.5;
    color = vec3f(enc(Lq));
  } else if (band < 2.5) {
    color = vec3f(enc(L), 0.0, 0.0);
  } else if (band < 3.5) {
    color = vec3f(0.0, enc(L), 0.0);
  } else if (band < 4.5) {
    color = vec3f(0.0, 0.0, enc(L));
  } else {
    // Paper-white reference strip held at exactly 1x for side-by-side comparison.
    color = vec3f(enc(1.0));
  }

  // Thin black separators between bands.
  let bandFrac = fract(bandF);
  let bandPx = fwidth(bandF);
  if (bandFrac < bandPx * 1.0 || bandFrac > 1.0 - bandPx * 1.0) {
    color = vec3f(0.0);
  }

  // Boundary marker at L = 1 (SDR reference white): dark core + bright outline so it
  // stays visible whether or not the display shows brighter-than-white.
  let markerX = 1.0 / MAX;
  let px = fwidth(x);
  let dist = abs(x - markerX);
  if (dist < px * 1.5) {
    color = vec3f(0.0);
  } else if (dist < px * 3.5) {
    color = vec3f(enc(1.6));
  }

  return vec4f(color, 1.0);
}
`;

export function HdrPreview() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<HdrPreviewStatus>("init");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      setStatus("unsupported");
      return;
    }

    let cancelled = false;
    let device: GPUDevice | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const run = async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          if (!cancelled) setStatus("unsupported");
          return;
        }
        const gpuDevice = await adapter.requestDevice();
        if (cancelled) {
          gpuDevice.destroy();
          return;
        }
        device = gpuDevice;
        const context = canvas.getContext("webgpu");
        if (!context) {
          setStatus("unsupported");
          return;
        }

        // Prefer the extended-range HDR configuration; fall back to plain SDR so the
        // pattern still renders (and visibly clamps past 1x, demonstrating no HDR).
        let format: GPUTextureFormat = "rgba16float";
        const hdr = configureCanvasForHdr(context, gpuDevice);
        if (!hdr) {
          format = navigator.gpu.getPreferredCanvasFormat();
          context.configure({ device: gpuDevice, format, alphaMode: "opaque" });
        }
        setStatus(hdr ? "hdr" : "sdr");

        const module = gpuDevice.createShaderModule({ code: SHADER });
        const pipeline = gpuDevice.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format }] },
          primitive: { topology: "triangle-list" }
        });

        const render = () => {
          if (cancelled || !device) {
            return;
          }
          const dpr = window.devicePixelRatio || 1;
          const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
          const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store"
              }
            ]
          });
          pass.setPipeline(pipeline);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
        };

        render();
        resizeObserver = new ResizeObserver(() => render());
        resizeObserver.observe(canvas);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    };

    void run();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      device?.destroy();
    };
  }, []);

  const statusText: Record<HdrPreviewStatus, string> = {
    init: "Initializing…",
    hdr: "Extended HDR active — bands past the 1× line should appear brighter than the white reference strip.",
    sdr: "HDR not available on this canvas — everything past the 1× line clamps to white (SDR).",
    unsupported: "WebGPU is required for the HDR preview.",
    error: `HDR preview error: ${errorMessage}`
  };

  return (
    <div className="hdr-preview">
      <div className="hdr-preview-block">
        {status === "unsupported" || status === "error" ? (
          <p className="hdr-preview-message">{statusText[status]}</p>
        ) : (
          <>
            <div className="hdr-preview-canvas-wrap">
              <canvas ref={canvasRef} className="hdr-preview-canvas" />
              <div className="hdr-preview-ticks">
                {[
                  { mult: 1, label: "1× SDR" },
                  { mult: 2, label: "2×" },
                  { mult: 3, label: "3×" },
                  { mult: 4, label: "4×" }
                ].map((tick) => (
                  <span
                    key={tick.mult}
                    className="hdr-preview-tick"
                    style={{ left: `${(tick.mult / MAX_MULTIPLIER) * 100}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
            <p className="hdr-preview-status">{statusText[status]}</p>
          </>
        )}
      </div>
      <HdrHistogram />
    </div>
  );
}

// Bar colors for the histogram. Bins at or below SDR white are neutral; bins in HDR
// range (luminance > 1×) are highlighted.
const HISTOGRAM_SDR_COLOR = "rgba(150, 170, 200, 0.85)";
const HISTOGRAM_HDR_COLOR = "rgba(255, 150, 60, 0.95)";
const HISTOGRAM_MARKER_COLOR = "rgba(255, 255, 255, 0.55)";

// Live luminance histogram of the viewport. Subscribing enables the viewport's per-frame
// readback (see hdrHistogramBridge); the >1× region is drawn in the HDR highlight color.
function HdrHistogram() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [result, setResult] = useState<HdrHistogramResult | null>(null);
  const resultRef = useRef<HdrHistogramResult | null>(null);
  resultRef.current = result;

  useEffect(() => subscribeHdrHistogram(setResult), []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, w, h);

    const data = resultRef.current;
    if (!data) {
      return;
    }
    // Include the overflow count in the peak so the y-scale accounts for clipped highlights.
    let maxCount = data.overflow;
    for (let i = 0; i < data.bins.length; i++) {
      const c = data.bins[i] ?? 0;
      if (c > maxCount) {
        maxCount = c;
      }
    }
    if (maxCount <= 0) {
      return;
    }
    // Log scale keeps sparse HDR highlights visible next to a dominant SDR peak.
    const logMax = Math.log1p(maxCount);
    const slots = HDR_HISTOGRAM_BINS + 1; // +1 for the overflow bar at the far right
    const barW = w / slots;
    const drawBar = (slot: number, count: number, hdr: boolean) => {
      if (count <= 0) {
        return;
      }
      const barH = (Math.log1p(count) / logMax) * (h - 2);
      ctx.fillStyle = hdr ? HISTOGRAM_HDR_COLOR : HISTOGRAM_SDR_COLOR;
      ctx.fillRect(slot * barW, h - barH, Math.max(1, barW - 1), barH);
    };
    const binWidthMult = HDR_HISTOGRAM_MAX / HDR_HISTOGRAM_BINS;
    for (let i = 0; i < HDR_HISTOGRAM_BINS; i++) {
      const center = (i + 0.5) * binWidthMult;
      drawBar(i, data.bins[i] ?? 0, center > 1);
    }
    drawBar(HDR_HISTOGRAM_BINS, data.overflow, true);

    // Vertical marker at the 1× (SDR white) boundary.
    const markerX = (1 / HDR_HISTOGRAM_MAX) * w;
    ctx.strokeStyle = HISTOGRAM_MARKER_COLOR;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(markerX, 0);
    ctx.lineTo(markerX, h);
    ctx.stroke();
  }, []);

  useEffect(() => {
    draw();
  }, [draw, result]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  let statusLine: string;
  if (!result) {
    statusLine = "Waiting for viewport…";
  } else if (result.fractionHdr <= 0) {
    statusLine = `Peak ${result.peakLuminance.toFixed(2)}× · No values above 1× (SDR range)`;
  } else {
    statusLine = `Peak ${result.peakLuminance.toFixed(2)}× · ${(result.fractionHdr * 100).toFixed(1)}% in HDR`;
  }

  return (
    <div className="hdr-histogram">
      <div className="hdr-preview-canvas-wrap">
        <canvas ref={canvasRef} className="hdr-histogram-canvas" />
        <div className="hdr-preview-ticks">
          {[
            { mult: 1, label: "1×" },
            { mult: 2, label: "2×" },
            { mult: 4, label: "4×" }
          ].map((tick) => (
            <span
              key={tick.mult}
              className="hdr-preview-tick"
              style={{ left: `${(tick.mult / MAX_MULTIPLIER) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <p className="hdr-preview-status">Viewport luminance · {statusLine}</p>
    </div>
  );
}

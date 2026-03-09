import type { RenderCaptureStrategy, RenderSettings } from "@/features/render/types";

export interface RenderExporterResult {
  summary: string;
}

export interface RenderExporter {
  writeFrame(framePngBytes: Uint8Array, frameIndex: number): Promise<void>;
  finalize(): Promise<RenderExporterResult>;
  abort(): Promise<void>;
}

interface RenderExportContext {
  projectName?: string;
}

function padFrame(frameIndex: number): string {
  return String(frameIndex).padStart(6, "0");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function sanitizeFolderNameSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Project";
  }
  // eslint-disable-next-line no-control-regex
  const sanitized = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  const withoutTrailingDots = sanitized.replace(/[. ]+$/g, "");
  return withoutTrailingDots || "Project";
}

function formatTimestampForFolderName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${String(year)}-${month}-${day} ${hours}.${minutes}.${seconds}`;
}

function buildRenderFolderName(projectName?: string): string {
  return `${sanitizeFolderNameSegment(projectName ?? "Project")} - ${formatTimestampForFolderName(new Date())}`;
}

function buildScript(encoder: string, fps: number, bitrateMbps: number, outputName: string): { sh: string; bat: string } {
  const ffmpegCommand = `ffmpeg -y -framerate ${String(fps)} -i frame_%06d.png -an -c:v ${encoder} -tag:v hvc1 -b:v ${String(bitrateMbps)}M -pix_fmt yuv420p "${outputName}"`;
  return {
    sh: `#!/usr/bin/env bash\nset -euo pipefail\n${ffmpegCommand}\n`,
    bat: `@echo off\r\n${ffmpegCommand}\r\n`
  };
}

async function createElectronPipeExporter(settings: RenderSettings): Promise<RenderExporter> {
  if (!window.electronAPI) {
    throw new Error("Pipe render is only available in Electron.");
  }
  const outputPath = await window.electronAPI.openSaveDialog({
    title: "Save rendered video",
    defaultFileName: "render.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }]
  });
  if (!outputPath) {
    throw new Error("Render cancelled.");
  }
  const open = await window.electronAPI.renderPipeOpen({
    outputPath,
    fps: settings.fps,
    bitrateMbps: settings.bitrateMbps
  });
  let closed = false;
  return {
    writeFrame: async (framePngBytes) => {
      if (closed) {
        throw new Error("Render pipe is closed.");
      }
      await window.electronAPI!.renderPipeWriteFrame({
        pipeId: open.pipeId,
        framePngBytes
      });
    },
    finalize: async () => {
      if (closed) {
        return { summary: `Saved ${outputPath}` };
      }
      closed = true;
      const done = await window.electronAPI!.renderPipeClose({ pipeId: open.pipeId });
      return { summary: done.summary };
    },
    abort: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await window.electronAPI!.renderPipeAbort({ pipeId: open.pipeId });
    }
  };
}

async function createElectronTempExporter(settings: RenderSettings, context?: RenderExportContext): Promise<RenderExporter> {
  if (!window.electronAPI) {
    throw new Error("Temp-folder export is unavailable.");
  }
  const folderPath = await window.electronAPI.openDirectoryDialog({
    title: "Choose output folder for render frames"
  });
  if (!folderPath) {
    throw new Error("Render cancelled.");
  }
  const init = await window.electronAPI.renderTempInit({
    folderPath,
    fps: settings.fps,
    bitrateMbps: settings.bitrateMbps,
    outputFileName: "render.mp4",
    frameFolderName: buildRenderFolderName(context?.projectName)
  });
  let closed = false;
  return {
    writeFrame: async (framePngBytes, frameIndex) => {
      if (closed) {
        throw new Error("Render temp job is closed.");
      }
      await window.electronAPI!.renderTempWriteFrame({
        jobId: init.jobId,
        frameIndex,
        framePngBytes
      });
    },
    finalize: async () => {
      if (closed) {
        return { summary: `Saved ${init.outputPath}` };
      }
      closed = true;
      const done = await window.electronAPI!.renderTempFinalize({ jobId: init.jobId });
      return { summary: done.summary };
    },
    abort: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await window.electronAPI!.renderTempAbort({ jobId: init.jobId });
    }
  };
}

async function createWebTempExporter(settings: RenderSettings, context?: RenderExportContext): Promise<RenderExporter> {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<any> }).showDirectoryPicker;
  if (!picker) {
    throw new Error("This browser does not support direct folder writing for temp renders.");
  }
  const rootDir = await picker();
  const folderName = buildRenderFolderName(context?.projectName);
  const renderDir = await rootDir.getDirectoryHandle(folderName, { create: true });
  let closed = false;
  let frameCount = 0;
  return {
    writeFrame: async (framePngBytes, frameIndex) => {
      if (closed) {
        throw new Error("Render job is closed.");
      }
      const file = await renderDir.getFileHandle(`frame_${padFrame(frameIndex)}.png`, { create: true });
      const writable = await file.createWritable();
      await writable.write(framePngBytes);
      await writable.close();
      frameCount += 1;
    },
    finalize: async () => {
      if (!closed) {
        const scripts = buildScript("hevc_nvenc", settings.fps, settings.bitrateMbps, "render.mp4");
        const shHandle = await renderDir.getFileHandle("encode.sh", { create: true });
        const shWrite = await shHandle.createWritable();
        await shWrite.write(scripts.sh);
        await shWrite.close();
        const batHandle = await renderDir.getFileHandle("encode.bat", { create: true });
        const batWrite = await batHandle.createWritable();
        await batWrite.write(scripts.bat);
        await batWrite.close();
        const readmeHandle = await renderDir.getFileHandle("README.txt", { create: true });
        const readmeWrite = await readmeHandle.createWritable();
        await readmeWrite.write(
          "Run encode.bat on Windows or encode.sh on macOS/Linux.\nIf hevc_nvenc is unavailable, replace encoder with libx265."
        );
        await readmeWrite.close();
        closed = true;
      }
      return { summary: `Wrote ${String(frameCount)} frames and encode scripts.` };
    },
    abort: async () => {
      closed = true;
    }
  };
}

export async function createRenderExporter(settings: RenderSettings, context?: RenderExportContext): Promise<RenderExporter> {
  if (settings.strategy === "pipe") {
    return await createElectronPipeExporter(settings);
  }
  if (window.electronAPI) {
    return await createElectronTempExporter(settings, context);
  }
  return await createWebTempExporter(settings, context);
}

export async function canvasToPngBytes(
  canvas: HTMLCanvasElement,
  outputSize?: { width: number; height: number }
): Promise<Uint8Array> {
  let sourceCanvas: HTMLCanvasElement = canvas;
  if (
    outputSize
    && outputSize.width > 0
    && outputSize.height > 0
    && (canvas.width !== outputSize.width || canvas.height !== outputSize.height)
  ) {
    const scaledCanvas = document.createElement("canvas");
    scaledCanvas.width = outputSize.width;
    scaledCanvas.height = outputSize.height;
    const context = scaledCanvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create downsample context.");
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
    sourceCanvas = scaledCanvas;
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    sourceCanvas.toBlob((value) => {
      if (!value) {
        reject(new Error("Failed to capture frame from canvas."));
        return;
      }
      resolve(value);
    }, "image/png");
  });
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export function pngBytesToDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

export function strategyLabel(strategy: RenderCaptureStrategy): string {
  return strategy === "pipe" ? "Pipe" : "Temp folder";
}

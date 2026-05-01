import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { BUILD_INFO, buildInfoSummary } from "@/app/buildInfo";
import { resolveDraggedPreviewFile, resolveDroppedFileSourcePath } from "@/app/dragDropFilePath";
import { installRendererDebugBridge } from "@/app/liveDebugBridge";
import { keyboardCommandRouter } from "@/app/keyboardCommandRouter";
import { isMacPlatform, isViewportFullscreenShortcut } from "@/app/viewportFullscreenShortcut";
import { registerCoreActorDescriptors, setupActorHotReload } from "@/features/actors/registerCoreActors";
import { interpolateCameraState } from "@/features/camera/cycleTween";
import {
  DEFAULT_CAMERA_TRANSITION_DURATION_MS,
  registerCameraTransitionDriver,
  type CameraTransitionRequestOptions
} from "@/features/camera/transitionController";
import {
  importFileAsActor,
  importFileIntoActor,
  listCompatibleActorFileImportOptions,
  resolveNewActorFileDropAction,
  resolveSelectedActorFileImportTarget,
  type ActorFileImportOption,
  type SelectedActorFileImportTarget
} from "@/features/imports/actorFileImport";
import {
  discoverAndLoadExternalPlugins,
  formatPluginDiscoverySummary,
  startExternalPluginAutoReload
} from "@/features/plugins/discovery";
import { PluginRuntimeHost } from "@/features/plugins/PluginRuntimeHost";
import { FlexLayoutHost } from "@/ui/FlexLayoutHost";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";
import { TitleBarPanel } from "@/ui/panels/TitleBarPanel";
import { FileImportModal } from "@/ui/components/FileImportModal";
import { KeyboardMapModal } from "@/ui/components/KeyboardMapModal";
import { TextInputModal } from "@/ui/components/TextInputModal";
import { RenderSettingsModal } from "@/ui/components/RenderSettingsModal";
import { ProfileCaptureModal } from "@/ui/components/ProfileCaptureModal";
import { RenderOverlay } from "@/ui/components/RenderOverlay";
import type { CameraState, SelectionEntry } from "@/core/types";
import type { RenderProgress, RenderSettings } from "@/features/render/types";
import { getCameraPathDurationSeconds } from "@/features/cameraPath/model";
import {
  defaultRenderCameraPathId,
  resolveRenderDurationSeconds
} from "@/features/render/settings";
import { computeFrameCount, frameSimTime } from "@/features/render/timeline";
import { solveRenderCamera } from "@/features/render/cameraSolver";
import { canvasToPngBytes, createRenderExporter } from "@/features/render/exporters";
import { createQueuedRenderExporter } from "@/features/render/queuedExporter";
import { WebGlViewport } from "@/render/webglRenderer";
import { WebGpuViewport } from "@/render/webgpuRenderer";
import type { ProfileCaptureOptions, ProfileSessionResult, ProfilingPublicState } from "@/render/profiling";

const RENDER_QUEUE_BUDGET_BYTES = 512 * 1024 * 1024;
const RENDER_PROGRESS_UPDATE_INTERVAL_MS = 125;
const RENDER_PREVIEW_UPDATE_INTERVAL_MS = 125;

interface ExportViewportRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  renderOnce(): Promise<void>;
}

interface DragImportState {
  hasResolvedFileMetadata: boolean;
  fileName: string;
  fileExtension: string;
  sourcePath: string | null;
  options: ActorFileImportOption[];
  replacementTarget: SelectedActorFileImportTarget | null;
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")) {
    return true;
  }
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest("[contenteditable='true']")) {
    return true;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const NAVIGATE_BACK_REQUEST_EVENT = "simularca:navigate-back-request";
const NAVIGATE_FORWARD_REQUEST_EVENT = "simularca:navigate-forward-request";

function cloneSelection(selection: SelectionEntry[]): SelectionEntry[] {
  return selection.map((entry) => ({ ...entry }));
}

function selectionStatesEqual(a: SelectionEntry[], b: SelectionEntry[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry, index) => entry.kind === b[index]?.kind && entry.id === b[index]?.id);
}

function isMouseBackEvent(event: MouseEvent | PointerEvent): boolean {
  return event.button === 3 || (typeof event.buttons === "number" && (event.buttons & 8) === 8);
}

function isMouseForwardEvent(event: MouseEvent | PointerEvent): boolean {
  return event.button === 4 || (typeof event.buttons === "number" && (event.buttons & 16) === 16);
}

export function App() {
  const kernel = useKernel();
  const dragDepthRef = useRef(0);
  const cameraTransitionRef = useRef<{
    from: CameraState;
    to: CameraState;
    startAtMs: number;
    durationMs: number;
    markDirty: boolean;
  } | null>(null);
  const cameraTransitionRafRef = useRef<number | null>(null);
  const [keyboardMapOpen, setKeyboardMapOpen] = useState(false);
  const [dragImportState, setDragImportState] = useState<DragImportState | null>(null);
  const [fileImportModalState, setFileImportModalState] = useState<DragImportState | null>(null);
  const [textInputRequest, setTextInputRequest] = useState<{
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [renderModalOpen, setRenderModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [renderOverlayOpen, setRenderOverlayOpen] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [viewportScreenshotRequestId, setViewportScreenshotRequestId] = useState(0);
  const [viewportScreenshotBusy, setViewportScreenshotBusy] = useState(false);
  const [viewportFullscreen, setViewportFullscreen] = useState(false);
  const renderHostElRef = useRef<HTMLDivElement | null>(null);
  const renderPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mainViewportSuspended, setMainViewportSuspended] = useState(false);
  const [profilingState, setProfilingState] = useState<ProfilingPublicState>(() => kernel.profiler.getState());
  const [profileResults, setProfileResults] = useState<ProfileSessionResult | null>(null);
  const [profileResultsOpen, setProfileResultsOpen] = useState(false);
  const renderCancelRequestedRef = useRef(false);
  const activeProjectName = useAppStore((store) => store.state.activeProjectName);
  const activeSnapshotName = useAppStore((store) => store.state.activeSnapshotName);
  const mode = useAppStore((store) => store.state.mode);
  const sceneRenderEngine = useAppStore((store) => store.state.scene.renderEngine);
  const sceneAntialiasing = useAppStore((store) => store.state.scene.antialiasing);
  const sceneColorBufferPrecision = useAppStore((store) => store.state.scene.colorBufferPrecision);
  const actors = useAppStore((store) => store.state.actors);
  const selection = useAppStore((store) => store.state.selection);
  const readOnly = mode === "web-ro";
  const macPlatform = useMemo(() => isMacPlatform(typeof navigator === "object" ? navigator.platform : ""), []);
  const selectionHistoryBackRef = useRef<SelectionEntry[][]>([]);
  const selectionHistoryForwardRef = useRef<SelectionEntry[][]>([]);
  const selectionHistorySuppressRef = useRef(false);
  const previousSelectionRef = useRef<SelectionEntry[]>(cloneSelection(selection));
  const syncRealViewportFullscreen = useCallback(
    async (nextFullscreen: boolean) => {
      if (window.electronAPI?.windowSetFullscreen) {
        try {
          const state = await window.electronAPI.windowSetFullscreen(nextFullscreen);
          setViewportFullscreen(state.isFullscreen);
        } catch (error) {
          setViewportFullscreen(false);
          const message = error instanceof Error ? error.message : "Unknown fullscreen error";
          kernel.store.getState().actions.setStatus(`Viewport fullscreen failed: ${message}`);
        }
        return;
      }

      try {
        if (nextFullscreen) {
          if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          }
        } else if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        setViewportFullscreen(Boolean(document.fullscreenElement));
      } catch (error) {
        setViewportFullscreen(Boolean(document.fullscreenElement));
        const message = error instanceof Error ? error.message : "Unknown fullscreen error";
        kernel.store.getState().actions.setStatus(`Viewport fullscreen failed: ${message}`);
      }
    },
    [kernel]
  );

  const requestViewportFullscreen = useCallback(
    (nextFullscreen: boolean) => {
      setViewportFullscreen(nextFullscreen);
      void syncRealViewportFullscreen(nextFullscreen);
    },
    [syncRealViewportFullscreen]
  );

  useEffect(() => {
    return kernel.profiler.subscribe(() => {
      const nextState = kernel.profiler.getState();
      setProfilingState(nextState);
      if (nextState.phase === "completed" && nextState.result) {
        setProfileResults(nextState.result);
        setProfileResultsOpen(true);
      }
    });
  }, [kernel]);

  useEffect(() => {
    if (window.electronAPI?.onWindowStateChange) {
      return window.electronAPI.onWindowStateChange((state) => {
        setViewportFullscreen(state.isFullscreen);
      });
    }

    const onFullscreenChange = () => {
      setViewportFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  const cancelCameraTransition = useCallback(() => {
    if (cameraTransitionRafRef.current !== null) {
      cancelAnimationFrame(cameraTransitionRafRef.current);
      cameraTransitionRafRef.current = null;
    }
    cameraTransitionRef.current = null;
  }, []);

  const sampleActiveCameraTransition = useCallback((nowMs: number): CameraState | null => {
    const active = cameraTransitionRef.current;
    if (!active) {
      return null;
    }
    const elapsed = nowMs - active.startAtMs;
    const t = Math.max(0, Math.min(1, elapsed / active.durationMs));
    return interpolateCameraState(active.from, active.to, t);
  }, []);

  const tickCameraTransition = useCallback(
    (nowMs: number) => {
      const active = cameraTransitionRef.current;
      if (!active) {
        cameraTransitionRafRef.current = null;
        return;
      }
      const elapsed = nowMs - active.startAtMs;
      const t = Math.max(0, Math.min(1, elapsed / active.durationMs));
      const nextCamera = interpolateCameraState(active.from, active.to, t);
      kernel.store.getState().actions.setCameraState(nextCamera, active.markDirty, {
        rememberPerspective: false
      });
      if (t >= 1) {
        kernel.store.getState().actions.setCameraState(active.to, active.markDirty);
        cameraTransitionRef.current = null;
        cameraTransitionRafRef.current = null;
        return;
      }
      cameraTransitionRafRef.current = requestAnimationFrame(tickCameraTransition);
    },
    [kernel]
  );

  const fileExtensionFromName = (fileName: string): string => {
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex === -1) {
      return "";
    }
    return fileName.slice(dotIndex).toLowerCase();
  };

  const createDragImportState = useCallback(
    (file?: File | null) => {
      const replacementTarget = resolveSelectedActorFileImportTarget(kernel, {
        actors,
        selection
      });
      if (!file) {
        return {
          hasResolvedFileMetadata: false,
          fileName: "",
          fileExtension: "",
          sourcePath: null,
          options: [] as ActorFileImportOption[],
          replacementTarget
        };
      }
      const fileName = file.name;
      const fileExtension = fileExtensionFromName(fileName);
      const sourcePath = resolveDroppedFileSourcePath(file, window.electronAPI);
      const options = listCompatibleActorFileImportOptions(kernel, fileName);
      return {
        hasResolvedFileMetadata: true,
        fileName,
        fileExtension,
        sourcePath,
        options,
        replacementTarget
      };
    },
    [actors, kernel, selection]
  );

  const performImport = useCallback(
    async (input: { descriptorId: string; fileName: string; sourcePath: string | null }) => {
      if (!input.sourcePath) {
        kernel.store
          .getState()
          .actions.setStatus("Unable to import dropped file: local file path could not be resolved from Electron.");
        return;
      }
      try {
        await importFileAsActor(kernel, {
          descriptorId: input.descriptorId,
          sourcePath: input.sourcePath,
          fileName: input.fileName,
          projectName: activeProjectName
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown file import error";
        kernel.store.getState().actions.setStatus(`Unable to import ${input.fileName}: ${message}`);
      }
    },
    [activeProjectName, kernel]
  );

  const performReplacementImport = useCallback(
    async (input: { target: SelectedActorFileImportTarget; fileName: string; sourcePath: string | null }) => {
      if (!input.sourcePath) {
        kernel.store
          .getState()
          .actions.setStatus("Unable to import dropped file: local file path could not be resolved from Electron.");
        return;
      }
      try {
        const imported = await importFileIntoActor(kernel, {
          actorId: input.target.actorId,
          definition: input.target.fileDefinition,
          sourcePath: input.sourcePath,
          projectName: activeProjectName
        });
        kernel.store
          .getState()
          .actions.setStatus(`${input.target.actorName}: replaced ${input.target.fileDefinition.label} with ${imported.asset.sourceFileName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown file import error";
        kernel.store.getState().actions.setStatus(`Unable to replace ${input.target.actorName}: ${message}`);
      }
    },
    [activeProjectName, kernel]
  );

  const handleNewActorDrop = useCallback(
    (input: DragImportState) => {
      const action = resolveNewActorFileDropAction(input.options);
      if (action.kind === "none") {
        kernel.store.getState().actions.setStatus(
          input.fileExtension
            ? `No actor types can load ${input.fileExtension} files.`
            : "No actor types can load this file."
        );
        return;
      }
      if (action.kind === "direct") {
        void performImport({
          descriptorId: action.descriptorId,
          fileName: input.fileName,
          sourcePath: input.sourcePath
        });
        return;
      }
      setFileImportModalState(input);
    },
    [kernel, performImport]
  );

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      if (!dragImportState) {
        const file = resolveDraggedPreviewFile(event.dataTransfer);
        setDragImportState(createDragImportState(file));
      }
    },
    [createDragImportState, dragImportState, readOnly]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const file = resolveDraggedPreviewFile(event.dataTransfer);
      const nextState = createDragImportState(file);
      if (
        !dragImportState ||
        dragImportState.hasResolvedFileMetadata !== nextState.hasResolvedFileMetadata ||
        dragImportState.fileName !== nextState.fileName
      ) {
        setDragImportState(nextState);
      }
    },
    [createDragImportState, dragImportState, readOnly]
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragImportState(null);
      }
    },
    [readOnly]
  );

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      const droppedFile = resolveDraggedPreviewFile(event.dataTransfer);
      const current = droppedFile ? createDragImportState(droppedFile) : dragImportState;
      setDragImportState(null);
      if (!current) {
        return;
      }
      handleNewActorDrop(current);
    },
    [createDragImportState, dragImportState, handleNewActorDrop, readOnly]
  );

  const handleImportZoneDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      const droppedFile = resolveDraggedPreviewFile(event.dataTransfer);
      const current = droppedFile ? createDragImportState(droppedFile) : dragImportState;
      setDragImportState(null);
      if (!current) {
        return;
      }
      handleNewActorDrop(current);
    },
    [createDragImportState, dragImportState, handleNewActorDrop, readOnly]
  );

  const handleReplacementZoneDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      const droppedFile = resolveDraggedPreviewFile(event.dataTransfer);
      const current = droppedFile ? createDragImportState(droppedFile) : dragImportState;
      setDragImportState(null);
      if (!current?.replacementTarget) {
        handleNewActorDrop(current ?? createDragImportState(droppedFile));
        return;
      }
      void performReplacementImport({
        target: current.replacementTarget,
        fileName: current.fileName,
        sourcePath: current.sourcePath
      });
    },
    [createDragImportState, dragImportState, handleNewActorDrop, performReplacementImport, readOnly]
  );

  const requestTextInput = useCallback(
    async (args: {
      title: string;
      label: string;
      initialValue?: string;
      placeholder?: string;
      confirmLabel?: string;
    }): Promise<string | null> =>
      await new Promise((resolve) => {
        setTextInputRequest({
          ...args,
          resolve
        });
      }),
    []
  );

  const handleRenderHostReady = useCallback((el: HTMLDivElement | null) => {
    renderHostElRef.current = el;
  }, []);
  const handleRenderPreviewReady = useCallback((el: HTMLCanvasElement | null) => {
    renderPreviewCanvasRef.current = el;
  }, []);

  const drawRenderPreview = useCallback((sourceCanvas: HTMLCanvasElement) => {
    const previewCanvas = renderPreviewCanvasRef.current;
    if (!previewCanvas) {
      return;
    }
    const displayWidth = Math.max(1, previewCanvas.clientWidth);
    const displayHeight = Math.max(1, previewCanvas.clientHeight);
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const targetWidth = Math.max(1, Math.round(displayWidth * devicePixelRatio));
    const targetHeight = Math.max(1, Math.round(displayHeight * devicePixelRatio));
    if (previewCanvas.width !== targetWidth || previewCanvas.height !== targetHeight) {
      previewCanvas.width = targetWidth;
      previewCanvas.height = targetHeight;
    }
    const context = previewCanvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, targetWidth, targetHeight);
    context.fillStyle = "#02070e";
    context.fillRect(0, 0, targetWidth, targetHeight);
    const scale = Math.min(targetWidth / sourceCanvas.width, targetHeight / sourceCanvas.height);
    const drawWidth = Math.max(1, sourceCanvas.width * scale);
    const drawHeight = Math.max(1, sourceCanvas.height * scale);
    const offsetX = (targetWidth - drawWidth) * 0.5;
    const offsetY = (targetHeight - drawHeight) * 0.5;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(sourceCanvas, offsetX, offsetY, drawWidth, drawHeight);
  }, []);

  const cameraPathActors = useMemo(
    () =>
      Object.values(actors)
        .filter((actor) => actor.actorType === "camera-path")
        .map((actor) => ({
          id: actor.id,
          label: actor.name,
          durationSeconds: getCameraPathDurationSeconds(actor, actors)
        })),
    [actors]
  );

  const runRender = useCallback(
    async (settings: RenderSettings) => {
      const stateBefore = kernel.store.getState().state;
      const previousCamera = structuredClone(stateBefore.camera);
      const previousTime = structuredClone(stateBefore.time);
      const effectiveDurationSeconds = resolveRenderDurationSeconds(settings, cameraPathActors);
      const internalWidth = settings.width * settings.supersampleScale;
      const internalHeight = settings.height * settings.supersampleScale;
      const warmupStepRate = Math.max(30, Math.min(60, settings.fps));
      const warmupStepCount = Math.max(0, Math.ceil(settings.preRunSeconds * warmupStepRate));
      const renderFrameCount = computeFrameCount(effectiveDurationSeconds, settings.fps);
      const overallUnitsTotal = Math.max(1, warmupStepCount + renderFrameCount * 2);
      setRenderModalOpen(false);
      setRenderOverlayOpen(true);
      setMainViewportSuspended(true);
      renderCancelRequestedRef.current = false;
      let renderedFrameCount = 0;
      let writtenFrameCount = 0;
      let queuedBytes = 0;
      let latestPhase: RenderProgress["phase"] = "prepare";
      let latestPhaseIndex = 0;
      let latestPhaseCount = Math.max(1, warmupStepCount || renderFrameCount || 1);
      let latestMessage = "Preparing...";
      let progressTimer: number | null = null;
      let lastProgressCommitAt = 0;
      let previewLastDrawAt = 0;
      const commitProgress = () => {
        progressTimer = null;
        lastProgressCommitAt = performance.now();
        setRenderProgress({
          phase: latestPhase,
          phaseIndex: latestPhaseIndex,
          phaseCount: latestPhaseCount,
          renderFrameCountTotal: renderFrameCount,
          renderedFrameCount,
          writtenFrameCount,
          queuedBytes,
          queueBudgetBytes: RENDER_QUEUE_BUDGET_BYTES,
          overallUnitsCompleted: Math.min(
            overallUnitsTotal,
            Math.max(0, latestPhase === "pre-run" ? latestPhaseIndex : warmupStepCount) + renderedFrameCount + writtenFrameCount
          ),
          overallUnitsTotal,
          message: latestMessage
        });
      };
      const pushProgress = (
        patch?: Partial<Pick<RenderProgress, "phase" | "phaseIndex" | "phaseCount" | "message">>,
        options?: { immediate?: boolean }
      ) => {
        if (patch?.phase) {
          latestPhase = patch.phase;
        }
        if (typeof patch?.phaseIndex === "number") {
          latestPhaseIndex = patch.phaseIndex;
        }
        if (typeof patch?.phaseCount === "number") {
          latestPhaseCount = patch.phaseCount;
        }
        if (typeof patch?.message === "string") {
          latestMessage = patch.message;
        }
        const immediate = options?.immediate === true || performance.now() - lastProgressCommitAt >= RENDER_PROGRESS_UPDATE_INTERVAL_MS;
        if (immediate) {
          if (progressTimer !== null) {
            window.clearTimeout(progressTimer);
            progressTimer = null;
          }
          commitProgress();
          return;
        }
        if (progressTimer === null) {
          progressTimer = window.setTimeout(() => {
            commitProgress();
          }, RENDER_PROGRESS_UPDATE_INTERVAL_MS);
        }
      };
      const updatePreview = (canvas: HTMLCanvasElement, immediate = false) => {
        const now = performance.now();
        if (!immediate && now - previewLastDrawAt < RENDER_PREVIEW_UPDATE_INTERVAL_MS) {
          return;
        }
        previewLastDrawAt = now;
        drawRenderPreview(canvas);
      };
      pushProgress(undefined, { immediate: true });
      let viewport: ExportViewportRuntime | null = null;
      let exporter: { abort(): Promise<void> } | null = null;
      try {
        let waitCount = 0;
        while (!renderHostElRef.current && waitCount < 120) {
          await new Promise((resolve) => setTimeout(resolve, 16));
          waitCount += 1;
        }
        const hostEl = renderHostElRef.current;
        if (!hostEl) {
          throw new Error("Render viewport host was not created.");
        }
        hostEl.style.width = `${String(internalWidth)}px`;
        hostEl.style.height = `${String(internalHeight)}px`;
        viewport =
          sceneRenderEngine === "webgl2"
            ? new WebGlViewport(kernel, hostEl, {
                antialias: sceneAntialiasing,
                colorBufferPrecision: sceneColorBufferPrecision,
                qualityMode: "export",
                manualFrameControl: true,
                showDebugHelpers: settings.showDebugViews,
                editorOverlays: false,
                viewportSize: {
                  width: internalWidth,
                  height: internalHeight
                }
              })
            : new WebGpuViewport(kernel, hostEl, {
                antialias: sceneAntialiasing,
                colorBufferPrecision: sceneColorBufferPrecision,
                qualityMode: "export",
                manualFrameControl: true,
                showDebugHelpers: settings.showDebugViews,
                editorOverlays: false,
                viewportSize: {
                  width: internalWidth,
                  height: internalHeight
                }
              });
        await viewport.start();
        await viewport.renderOnce();
        const startTime = settings.startTimeMode === "zero" ? 0 : previousTime.elapsedSimSeconds;
        const simulationStartTime = startTime + settings.preRunSeconds;
        const baseExporter = await createRenderExporter(settings, {
          projectName: activeProjectName
        });
        const queuedExporter = createQueuedRenderExporter(baseExporter, {
          queueBudgetBytes: RENDER_QUEUE_BUDGET_BYTES,
          onStateChange: (state) => {
            writtenFrameCount = state.writtenFrameCount;
            queuedBytes = state.queuedBytes;
            pushProgress();
          }
        });
        exporter = queuedExporter;
        kernel.store.getState().actions.setTimeRunning(false);
        kernel.store.getState().actions.setTimeSpeed(1);

        if (warmupStepCount > 0) {
          for (let warmupIndex = 0; warmupIndex < warmupStepCount; warmupIndex += 1) {
            if (renderCancelRequestedRef.current) {
              throw new Error("Render cancelled.");
            }
            const alpha = (warmupIndex + 1) / warmupStepCount;
            const simTime = startTime + settings.preRunSeconds * alpha;
            kernel.store.getState().actions.setElapsedSimSeconds(simTime);
            kernel.store.getState().actions.setCameraState(previousCamera, false, {
              rememberPerspective: false
            });
            pushProgress({
              phase: "pre-run",
              phaseIndex: warmupIndex + 1,
              phaseCount: warmupStepCount,
              message: "Pre-running simulation..."
            }, { immediate: warmupIndex === 0 || warmupIndex + 1 === warmupStepCount });
            await viewport.renderOnce();
            const previewCanvas = hostEl.querySelector("canvas");
            if (previewCanvas instanceof HTMLCanvasElement) {
              updatePreview(previewCanvas);
            }
          }
        }

        for (let frameIndex = 0; frameIndex < renderFrameCount; frameIndex += 1) {
          if (renderCancelRequestedRef.current) {
            throw new Error("Render cancelled.");
          }
          const simTime = frameSimTime(simulationStartTime, frameIndex, settings.fps);
          kernel.store.getState().actions.setElapsedSimSeconds(simTime);
          const nextCamera = solveRenderCamera(
            kernel.store.getState().state,
            previousCamera,
            frameSimTime(0, frameIndex, settings.fps),
            settings.cameraPathId
          );
          kernel.store.getState().actions.setCameraState(nextCamera, false, {
            rememberPerspective: false
          });
          pushProgress({
            phase: "render",
            phaseIndex: frameIndex + 1,
            phaseCount: renderFrameCount,
            message: "Rendering frame..."
          }, { immediate: frameIndex === 0 });
          await viewport.renderOnce();
          const canvas = hostEl.querySelector("canvas");
          if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error("Render canvas is unavailable.");
          }
          updatePreview(canvas);
          const bytes = await canvasToPngBytes(canvas, {
            width: settings.width,
            height: settings.height
          });
          renderedFrameCount = frameIndex + 1;
          pushProgress({
            phase: "render",
            phaseIndex: renderedFrameCount,
            phaseCount: renderFrameCount,
            message: "Queueing frame for output..."
          }, { immediate: frameIndex + 1 === renderFrameCount });
          await queuedExporter.enqueueFrame(bytes, frameIndex);
        }
        pushProgress({
          phase: "drain",
          phaseIndex: writtenFrameCount,
          phaseCount: renderFrameCount,
          message: "Draining output queue..."
        }, { immediate: true });
        const result = await queuedExporter.finalize();
        kernel.store.getState().actions.setStatus(`Render finished. ${result.summary}`);
        await viewport.stop();
        viewport = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown render failure";
        kernel.store.getState().actions.setStatus(`Render failed: ${message}`);
        if (exporter) {
          await exporter.abort().catch(() => undefined);
        }
      } finally {
        if (viewport) {
          await viewport.stop();
        }
        kernel.store.getState().actions.setCameraState(previousCamera, false, {
          rememberPerspective: false
        });
        kernel.store.getState().actions.setElapsedSimSeconds(previousTime.elapsedSimSeconds);
        kernel.store.getState().actions.setTimeRunning(previousTime.running);
        kernel.store.getState().actions.setTimeSpeed(previousTime.speed);
        if (progressTimer !== null) {
          window.clearTimeout(progressTimer);
        }
        setMainViewportSuspended(false);
        setRenderOverlayOpen(false);
        setRenderProgress(null);
      }
    },
    [
      activeProjectName,
      cameraPathActors,
      drawRenderPreview,
      kernel,
      sceneAntialiasing,
      sceneColorBufferPrecision,
      sceneRenderEngine
    ]
  );

  useEffect(() => {
    const unregister = registerCameraTransitionDriver({
      request: (targetCamera: CameraState, options?: CameraTransitionRequestOptions) => {
        const animated = options?.animated ?? false;
        const durationMs = Math.max(0, Math.round(options?.durationMs ?? DEFAULT_CAMERA_TRANSITION_DURATION_MS));
        const markDirty = options?.markDirty ?? true;
        const from = sampleActiveCameraTransition(performance.now()) ?? structuredClone(kernel.store.getState().state.camera);
        cancelCameraTransition();
        const sameCamera =
          JSON.stringify(from.position) === JSON.stringify(targetCamera.position) &&
          JSON.stringify(from.target) === JSON.stringify(targetCamera.target) &&
          from.mode === targetCamera.mode &&
          Math.abs(from.fov - targetCamera.fov) <= 1e-6 &&
          Math.abs(from.zoom - targetCamera.zoom) <= 1e-6 &&
          Math.abs(from.near - targetCamera.near) <= 1e-6 &&
          Math.abs(from.far - targetCamera.far) <= 1e-6;
        if (!animated || durationMs <= 0 || sameCamera) {
          kernel.store.getState().actions.setCameraState(targetCamera, markDirty);
          return;
        }
        cameraTransitionRef.current = {
          from,
          to: structuredClone(targetCamera),
          startAtMs: performance.now(),
          durationMs,
          markDirty
        };
        cameraTransitionRafRef.current = requestAnimationFrame(tickCameraTransition);
      },
      cancel: () => {
        cancelCameraTransition();
      }
    });
    return () => {
      cancelCameraTransition();
      unregister();
    };
  }, [cancelCameraTransition, kernel, sampleActiveCameraTransition, tickCameraTransition]);

  useEffect(() => {
    kernel.store.getState().actions.setStatus(buildInfoSummary(BUILD_INFO));
    registerCoreActorDescriptors(kernel);
    setupActorHotReload(kernel);
    const unsubscribe = kernel.hotReloadManager.subscribe((event) => {
      if (event.applied) {
        kernel.store.getState().actions.setStatus(`Hot reload applied: ${event.moduleId}`);
      } else {
        kernel.store
          .getState()
          .actions.setStatus(`Hot reload fallback: ${event.moduleId} (${event.fallbackReason ?? "unknown reason"})`);
      }
    });
    void (async () => {
      if (window.electronAPI) {
        try {
          const report = await discoverAndLoadExternalPlugins(kernel);
          kernel.store.getState().actions.setStatus(`Plugins discovered. ${formatPluginDiscoverySummary(report)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown plugin discovery error";
          kernel.store.getState().actions.setStatus(`Plugin auto-load failed: ${message}`);
        }
      }
      await kernel.projectService.loadDefaultProject();
    })();
    return () => {
      unsubscribe();
    };
  }, [kernel]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }
    return startExternalPluginAutoReload(kernel);
  }, [kernel]);

  useEffect(() => {
    if (!window.electronAPI || BUILD_INFO.buildKind !== "dev") {
      return;
    }
    return installRendererDebugBridge(kernel);
  }, [kernel]);

  useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      const detail = event.error instanceof Error ? event.error.stack ?? event.error.message : event.message;
      kernel.store.getState().actions.addLog({
        level: "error",
        message: event.message || "Unhandled window error",
        details: detail
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const detail =
        reason instanceof Error
          ? reason.stack ?? reason.message
          : typeof reason === "string"
            ? reason
            : JSON.stringify(reason, null, 2);
      kernel.store.getState().actions.addLog({
        level: "error",
        message: "Unhandled promise rejection",
        details: detail
      });
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [kernel]);

  useEffect(() => {
    const previousSelection = previousSelectionRef.current;
    if (selectionStatesEqual(previousSelection, selection)) {
      return;
    }
    if (selectionHistorySuppressRef.current) {
      selectionHistorySuppressRef.current = false;
      previousSelectionRef.current = cloneSelection(selection);
      return;
    }
    const backHistory = selectionHistoryBackRef.current;
    if (!selectionStatesEqual(backHistory[backHistory.length - 1] ?? [], previousSelection)) {
      backHistory.push(cloneSelection(previousSelection));
    }
    selectionHistoryForwardRef.current = [];
    previousSelectionRef.current = cloneSelection(selection);
  }, [selection]);

  const handleNavigateBack = useCallback((): boolean => {
    const backRequest = new CustomEvent<{ handled: boolean }>(NAVIGATE_BACK_REQUEST_EVENT, {
      detail: { handled: false }
    });
    window.dispatchEvent(backRequest);
    if (backRequest.detail.handled) {
      return true;
    }

    const history = selectionHistoryBackRef.current;
    let previousSelection: SelectionEntry[] | undefined;
    while (history.length > 0) {
      const candidate = history.pop();
      if (!candidate) {
        continue;
      }
      if (!selectionStatesEqual(candidate, selection)) {
        previousSelection = candidate;
        break;
      }
    }
    if (!previousSelection) {
      return false;
    }

    selectionHistorySuppressRef.current = true;
    const actions = kernel.store.getState().actions;
    const currentSelection = cloneSelection(selection);
    if (!selectionStatesEqual(selectionHistoryForwardRef.current[selectionHistoryForwardRef.current.length - 1] ?? [], currentSelection)) {
      selectionHistoryForwardRef.current.push(currentSelection);
    }
    if (previousSelection.length === 0) {
      actions.clearSelection();
      return true;
    }
    actions.select(previousSelection, false);
    return true;
  }, [kernel, selection]);

  const handleNavigateForward = useCallback((): boolean => {
    const forwardRequest = new CustomEvent<{ handled: boolean }>(NAVIGATE_FORWARD_REQUEST_EVENT, {
      detail: { handled: false }
    });
    window.dispatchEvent(forwardRequest);
    if (forwardRequest.detail.handled) {
      return true;
    }

    const history = selectionHistoryForwardRef.current;
    let nextSelection: SelectionEntry[] | undefined;
    while (history.length > 0) {
      const candidate = history.pop();
      if (!candidate) {
        continue;
      }
      if (!selectionStatesEqual(candidate, selection)) {
        nextSelection = candidate;
        break;
      }
    }
    if (!nextSelection) {
      return false;
    }

    selectionHistorySuppressRef.current = true;
    const currentSelection = cloneSelection(selection);
    if (!selectionStatesEqual(selectionHistoryBackRef.current[selectionHistoryBackRef.current.length - 1] ?? [], currentSelection)) {
      selectionHistoryBackRef.current.push(currentSelection);
    }
    const actions = kernel.store.getState().actions;
    if (nextSelection.length === 0) {
      actions.clearSelection();
      return true;
    }
    actions.select(nextSelection, false);
    return true;
  }, [kernel, selection]);

  useEffect(() => {
    let backGestureConsumed = false;
    let forwardGestureConsumed = false;

    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      if (!isMouseBackEvent(event) && !isMouseForwardEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (isMouseBackEvent(event)) {
        backGestureConsumed = false;
      }
      if (isMouseForwardEvent(event)) {
        forwardGestureConsumed = false;
      }
    };

    const onPointerTrigger = (event: MouseEvent | PointerEvent) => {
      if (isMouseBackEvent(event)) {
        if (backGestureConsumed) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        backGestureConsumed = true;
        handleNavigateBack();
        return;
      }
      if (!isMouseForwardEvent(event) || forwardGestureConsumed) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      forwardGestureConsumed = true;
      handleNavigateForward();
    };

    const onAuxClick = (event: MouseEvent) => {
      onPointerTrigger(event);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerTrigger, true);
    window.addEventListener("mouseup", onPointerTrigger, true);
    window.addEventListener("auxclick", onAuxClick, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerTrigger, true);
      window.removeEventListener("mouseup", onPointerTrigger, true);
      window.removeEventListener("auxclick", onAuxClick, true);
    };
  }, [handleNavigateBack, handleNavigateForward]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (viewportFullscreen && event.key === "Escape") {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        requestViewportFullscreen(false);
        return;
      }
      if (isViewportFullscreenShortcut(event, macPlatform)) {
        event.preventDefault();
        requestViewportFullscreen(!viewportFullscreen);
        return;
      }
      const actions = kernel.store.getState().actions;

      if (event.key === " ") {
        event.preventDefault();
        const running = kernel.store.getState().state.time.running;
        actions.setTimeRunning(!running);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        if (keyboardCommandRouter.dispatch("delete-selection", event)) {
          return;
        }
        actions.deleteSelection();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "a") {
        if (event.repeat) {
          return;
        }
        if (keyboardCommandRouter.dispatch("open-add-actor-browser", event)) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "?") {
        event.preventDefault();
        setKeyboardMapOpen((value) => !value);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) {
          void requestTextInput({
            title: "Save Snapshot As",
            label: "Snapshot name",
            initialValue: activeSnapshotName,
            confirmLabel: "Save"
          }).then((nextName) => {
            if (nextName) {
              void kernel.projectService.saveSnapshotAs(nextName);
            }
          });
          return;
        }
        void kernel.projectService.saveProject();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          actions.redo();
        } else {
          actions.undo();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeSnapshotName, kernel, macPlatform, requestTextInput, requestViewportFullscreen, viewportFullscreen]);

  const topBar = useMemo(
    () => (
      <TopBarPanel
        onToggleKeyboardMap={() => setKeyboardMapOpen((value) => !value)}
        onOpenRender={() => setRenderModalOpen(true)}
        onOpenProfiling={() => setProfileModalOpen(true)}
        onCaptureViewportScreenshot={() => {
          if (viewportScreenshotBusy) {
            return;
          }
          setViewportScreenshotBusy(true);
          setViewportScreenshotRequestId((value) => value + 1);
        }}
        canCaptureViewportScreenshot={Boolean(window.electronAPI?.writeClipboardImagePng)}
        viewportScreenshotBusy={viewportScreenshotBusy}
        profilingState={profilingState}
        requestTextInput={requestTextInput}
      />
    ),
    [profilingState, requestTextInput, viewportScreenshotBusy]
  );
  const titleBar = useMemo(
    () => <TitleBarPanel requestTextInput={requestTextInput} />,
    [requestTextInput]
  );

  return (
    <div
      className="app-root"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleRootDrop}
    >
      <FlexLayoutHost
        titleBar={titleBar}
        topBar={topBar}
        pendingDropFileName={dragImportState?.fileName ?? null}
        viewportSuspended={mainViewportSuspended}
        viewportFullscreen={viewportFullscreen}
        viewportScreenshotRequestId={viewportScreenshotRequestId}
        onViewportScreenshotBusyChange={setViewportScreenshotBusy}
        profileResults={profileResults}
        profileResultsOpen={profileResultsOpen}
        onCloseProfileResults={() => {
          setProfileResultsOpen(false);
          setProfileResults(null);
          kernel.profiler.clearResult();
        }}
      />
      {dragImportState ? (
        <div className={`file-drop-overlay${dragImportState.hasResolvedFileMetadata ? "" : " is-pending"}`}>
          <div className="file-drop-overlay-head">
            <h2>Drop File To Import</h2>
            <p>{dragImportState.hasResolvedFileMetadata ? dragImportState.fileName : "Release to inspect import options"}</p>
            <small>
              {!dragImportState.hasResolvedFileMetadata
                ? dragImportState.replacementTarget
                  ? "Drop on the inspector zone to replace the selected actor now, or keep dragging until import options resolve."
                  : "Electron has not exposed the dragged filename yet. Keep dragging or release to continue."
                : dragImportState.replacementTarget
                  ? "Drop on the inspector zone to replace the selected actor, or on the import zone to add a new actor."
                  : "Drop on the import zone below to add a new actor."}
            </small>
          </div>
          <div
            className={`file-drop-overlay-grid${dragImportState.replacementTarget ? " has-replace-target" : ""}`}
          >
            <div
              className={`file-drop-target${
                dragImportState.hasResolvedFileMetadata && dragImportState.options.length === 0 ? " is-disabled" : ""
              }${dragImportState.hasResolvedFileMetadata ? "" : " is-pending"}`}
              onDragOver={(event) => {
                if (!dataTransferHasFiles(event.dataTransfer)) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect =
                  dragImportState.hasResolvedFileMetadata && dragImportState.options.length === 0 ? "none" : "copy";
              }}
              onDrop={handleImportZoneDrop}
            >
              <div className="file-drop-target-icon">NEW</div>
              <strong>Import As New Actor</strong>
              <span>
                {!dragImportState.hasResolvedFileMetadata
                  ? "Release to inspect compatible actor types."
                  : dragImportState.options.length === 0
                  ? "No actor types can create a new actor from this file."
                  : dragImportState.options.length === 1
                    ? `Auto-import as ${dragImportState.options[0]?.label ?? "actor"}.`
                    : `Choose from ${dragImportState.options.length} compatible actor types.`}
              </span>
            </div>
            {dragImportState.replacementTarget ? (
              <div
                className="file-drop-target is-replace"
                onDragOver={(event) => {
                  if (!dataTransferHasFiles(event.dataTransfer)) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={handleReplacementZoneDrop}
              >
                <div className="file-drop-target-icon">REPLACE</div>
                <strong>Replace Selected Actor Asset</strong>
                <span>{dragImportState.replacementTarget.actorName}</span>
                <small>{dragImportState.replacementTarget.fileDefinition.label}</small>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <FileImportModal
        open={fileImportModalState !== null}
        fileName={fileImportModalState?.fileName ?? ""}
        fileExtension={fileImportModalState?.fileExtension ?? ""}
        options={fileImportModalState?.options ?? []}
        onConfirm={(descriptorId) => {
          const state = fileImportModalState;
          setFileImportModalState(null);
          if (!state) {
            return;
          }
          void performImport({
            descriptorId,
            fileName: state.fileName,
            sourcePath: state.sourcePath
          });
        }}
        onCancel={() => {
          setFileImportModalState(null);
        }}
      />
      <KeyboardMapModal open={keyboardMapOpen} onClose={() => setKeyboardMapOpen(false)} />
      <TextInputModal
        open={textInputRequest !== null}
        title={textInputRequest?.title ?? ""}
        label={textInputRequest?.label ?? ""}
        initialValue={textInputRequest?.initialValue}
        placeholder={textInputRequest?.placeholder}
        confirmLabel={textInputRequest?.confirmLabel}
        onConfirm={(value) => {
          const request = textInputRequest;
          setTextInputRequest(null);
          request?.resolve(value.trim());
        }}
        onCancel={() => {
          const request = textInputRequest;
          setTextInputRequest(null);
          request?.resolve(null);
        }}
      />
      <RenderSettingsModal
        open={renderModalOpen}
        isElectron={Boolean(window.electronAPI)}
        defaults={buildDefaultRenderSettings(cameraPathActors)}
        cameraPathActors={cameraPathActors}
        onCancel={() => setRenderModalOpen(false)}
        onConfirm={(settings) => {
          void runRender(settings);
        }}
      />
      <ProfileCaptureModal
        open={profileModalOpen}
        profilingState={profilingState}
        onCancel={() => setProfileModalOpen(false)}
        onConfirm={(options: ProfileCaptureOptions) => {
          setProfileModalOpen(false);
          if (!kernel.profiler.startCapture(options)) {
            kernel.store.getState().actions.setStatus("Performance profile capture is already running.");
          }
        }}
      />
      <RenderOverlay
        open={renderOverlayOpen}
        progress={renderProgress}
        onHostReady={handleRenderHostReady}
        onPreviewReady={handleRenderPreviewReady}
        onCancel={() => {
          renderCancelRequestedRef.current = true;
        }}
      />
      <PluginRuntimeHost />
    </div>
  );
}

function buildDefaultRenderSettings(
  cameraPathActors: Array<{ id: string }>
): RenderSettings {
  return {
    resolutionPreset: "fhd",
    width: 1920,
    height: 1080,
    supersampleScale: 1,
    fps: 24,
    bitrateMbps: 100,
    durationSeconds: 10,
    preRunSeconds: 0,
    showDebugViews: false,
    startTimeMode: "current",
    cameraPathId: defaultRenderCameraPathId(cameraPathActors),
    strategy: window.electronAPI ? "pipe" : "temp-folder"
  };
}

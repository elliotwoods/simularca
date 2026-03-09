import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { BUILD_INFO, buildInfoSummary } from "@/app/buildInfo";
import { keyboardCommandRouter } from "@/app/keyboardCommandRouter";
import {
  buildCameraCycleTargets,
  findCurrentCycleIndex,
  interpolateCameraState,
  type CameraCycleTarget
} from "@/features/camera/cycleTween";
import { registerCoreActorDescriptors, setupActorHotReload } from "@/features/actors/registerCoreActors";
import { importFileAsActor, listCompatibleActorFileImportOptions, type ActorFileImportOption } from "@/features/imports/actorFileImport";
import { discoverAndLoadLocalPlugins, formatPluginDiscoverySummary } from "@/features/plugins/discovery";
import { FlexLayoutHost } from "@/ui/FlexLayoutHost";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";
import { TitleBarPanel } from "@/ui/panels/TitleBarPanel";
import { FileImportModal } from "@/ui/components/FileImportModal";
import { KeyboardMapModal } from "@/ui/components/KeyboardMapModal";
import { TextInputModal } from "@/ui/components/TextInputModal";
import { RenderSettingsModal } from "@/ui/components/RenderSettingsModal";
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
import { WebGlViewport } from "@/render/webglRenderer";
import { WebGpuViewport } from "@/render/webgpuRenderer";

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
  type ActiveCameraTween = {
    from: CameraState;
    to: CameraState;
    startAtMs: number;
    durationMs: number;
    target: CameraCycleTarget;
  };
  const kernel = useKernel();
  const dragDepthRef = useRef(0);
  const cameraTweenRef = useRef<ActiveCameraTween | null>(null);
  const cameraTweenRafRef = useRef<number | null>(null);
  const [keyboardMapOpen, setKeyboardMapOpen] = useState(false);
  const [dragImportState, setDragImportState] = useState<{
    fileName: string;
    fileExtension: string;
    sourcePath: string | null;
    options: ActorFileImportOption[];
  } | null>(null);
  const [fileImportModalState, setFileImportModalState] = useState<{
    fileName: string;
    fileExtension: string;
    sourcePath: string | null;
    options: ActorFileImportOption[];
  } | null>(null);
  const [textInputRequest, setTextInputRequest] = useState<{
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [renderModalOpen, setRenderModalOpen] = useState(false);
  const [renderOverlayOpen, setRenderOverlayOpen] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const renderHostElRef = useRef<HTMLDivElement | null>(null);
  const [mainViewportSuspended, setMainViewportSuspended] = useState(false);
  const renderCancelRequestedRef = useRef(false);
  const activeProjectName = useAppStore((store) => store.state.activeProjectName);
  const activeSnapshotName = useAppStore((store) => store.state.activeSnapshotName);
  const mode = useAppStore((store) => store.state.mode);
  const sceneRenderEngine = useAppStore((store) => store.state.scene.renderEngine);
  const sceneAntialiasing = useAppStore((store) => store.state.scene.antialiasing);
  const actors = useAppStore((store) => store.state.actors);
  const selection = useAppStore((store) => store.state.selection);
  const readOnly = mode === "web-ro";
  const selectionHistoryBackRef = useRef<SelectionEntry[][]>([]);
  const selectionHistoryForwardRef = useRef<SelectionEntry[][]>([]);
  const selectionHistorySuppressRef = useRef(false);
  const previousSelectionRef = useRef<SelectionEntry[]>(cloneSelection(selection));

  const fileExtensionFromName = (fileName: string): string => {
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex === -1) {
      return "";
    }
    return fileName.slice(dotIndex).toLowerCase();
  };

  const createDragImportState = useCallback(
    (file?: File | null) => {
      if (!file) {
        return {
          fileName: "Pending file import",
          fileExtension: "",
          sourcePath: null,
          options: [] as ActorFileImportOption[]
        };
      }
      const fileName = file.name;
      const fileExtension = fileExtensionFromName(fileName);
      const sourcePath = (file as File & { path?: string }).path ?? null;
      const options = listCompatibleActorFileImportOptions(kernel, fileName);
      return {
        fileName,
        fileExtension,
        sourcePath,
        options
      };
    },
    [kernel]
  );

  const performImport = useCallback(
    async (input: { descriptorId: string; fileName: string; sourcePath: string | null }) => {
      if (!input.sourcePath) {
        kernel.store
          .getState()
          .actions.setStatus("Drag-and-drop import requires desktop (Electron) mode with local file path access.");
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

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !dataTransferHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      if (dragImportState) {
        return;
      }
      const file = event.dataTransfer.files?.[0];
      setDragImportState(createDragImportState(file));
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
      if (!dragImportState) {
        const file = event.dataTransfer.files?.[0];
        setDragImportState(createDragImportState(file));
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
      const droppedFile = event.dataTransfer.files?.[0];
      const current = droppedFile ? createDragImportState(droppedFile) : dragImportState;
      setDragImportState(null);
      if (!current) {
        return;
      }
      setFileImportModalState(current);
    },
    [createDragImportState, dragImportState, readOnly]
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

  const sampleActiveCameraTween = useCallback((nowMs: number): CameraState | null => {
    const active = cameraTweenRef.current;
    if (!active) {
      return null;
    }
    const elapsed = nowMs - active.startAtMs;
    const t = Math.max(0, Math.min(1, elapsed / active.durationMs));
    return interpolateCameraState(active.from, active.to, t);
  }, []);

  const stopCameraTween = useCallback(() => {
    if (cameraTweenRafRef.current !== null) {
      cancelAnimationFrame(cameraTweenRafRef.current);
      cameraTweenRafRef.current = null;
    }
    cameraTweenRef.current = null;
  }, []);

  const tickCameraTween = useCallback(
    (nowMs: number) => {
      const active = cameraTweenRef.current;
      if (!active) {
        cameraTweenRafRef.current = null;
        return;
      }
      const elapsed = nowMs - active.startAtMs;
      const t = Math.max(0, Math.min(1, elapsed / active.durationMs));
      const nextCamera = interpolateCameraState(active.from, active.to, t);
      kernel.store.getState().actions.setCameraState(nextCamera, true);
      if (t >= 1) {
        kernel.store.getState().actions.setCameraState(active.to, true);
        cameraTweenRef.current = null;
        cameraTweenRafRef.current = null;
        return;
      }
      cameraTweenRafRef.current = requestAnimationFrame(tickCameraTween);
    },
    [kernel]
  );

  const startCameraTween = useCallback(
    (target: CameraCycleTarget) => {
      const nowMs = performance.now();
      const currentFrom = sampleActiveCameraTween(nowMs) ?? kernel.store.getState().state.camera;
      cameraTweenRef.current = {
        from: currentFrom,
        to: structuredClone(target.camera),
        startAtMs: nowMs,
        durationMs: 1000,
        target
      };
      kernel.store.getState().actions.setStatus(`Camera tween to ${target.label}`);
      if (cameraTweenRafRef.current === null) {
        cameraTweenRafRef.current = requestAnimationFrame(tickCameraTween);
      }
    },
    [kernel, sampleActiveCameraTween, tickCameraTween]
  );

  const cycleCameraByTab = useCallback(
    (direction: 1 | -1) => {
      const state = kernel.store.getState().state;
      const targets = buildCameraCycleTargets(state);
      if (targets.length === 0) {
        return;
      }
      const nowMs = performance.now();
      const cameraNow = sampleActiveCameraTween(nowMs) ?? state.camera;
      const currentIndex = findCurrentCycleIndex(cameraNow, targets);
      const normalizedCurrent = currentIndex < 0 ? 0 : currentIndex;
      const nextIndex = (normalizedCurrent + direction + targets.length) % targets.length;
      const target = targets[nextIndex];
      if (!target) {
        return;
      }
      startCameraTween(target);
    },
    [kernel, sampleActiveCameraTween, startCameraTween]
  );

  const handleRenderHostReady = useCallback((el: HTMLDivElement | null) => {
    renderHostElRef.current = el;
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
      setRenderModalOpen(false);
      setRenderOverlayOpen(true);
      setMainViewportSuspended(true);
      renderCancelRequestedRef.current = false;
      setRenderProgress({
        frameIndex: 0,
        frameCount: Math.max(1, warmupStepCount + computeFrameCount(effectiveDurationSeconds, settings.fps)),
        message: "Preparing..."
      });
      let viewport: { start(): Promise<void>; stop(): void } | null = null;
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
                qualityMode: "export",
                showDebugHelpers: settings.showDebugViews,
                editorOverlays: false
              })
            : new WebGpuViewport(kernel, hostEl, {
                antialias: sceneAntialiasing,
                qualityMode: "export",
                showDebugHelpers: settings.showDebugViews,
                editorOverlays: false
              });
        await viewport.start();
        const frameCount = computeFrameCount(effectiveDurationSeconds, settings.fps);
        const startTime = settings.startTimeMode === "zero" ? 0 : previousTime.elapsedSimSeconds;
        const simulationStartTime = startTime + settings.preRunSeconds;
        const writeExporter = await createRenderExporter(settings, {
          projectName: activeProjectName
        });
        exporter = writeExporter;
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
            kernel.store.getState().actions.setCameraState(previousCamera, false);
            setRenderProgress({
              frameIndex: warmupIndex,
              frameCount: warmupStepCount + frameCount,
              message: "Pre-running simulation..."
            });
            await nextAnimationFrame();
          }
          await nextAnimationFrame();
          await nextAnimationFrame();
        }

        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
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
          kernel.store.getState().actions.setCameraState(nextCamera, false);
          setRenderProgress({
            frameIndex: warmupStepCount + frameIndex,
            frameCount: warmupStepCount + frameCount,
            message: "Rendering frame..."
          });
          await nextAnimationFrame();
          await nextAnimationFrame();
          const canvas = hostEl.querySelector("canvas");
          if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error("Render canvas is unavailable.");
          }
          const bytes = await canvasToPngBytes(canvas, {
            width: settings.width,
            height: settings.height
          });
          await writeExporter.writeFrame(bytes, frameIndex);
          setRenderProgress({
            frameIndex: warmupStepCount + frameIndex,
            frameCount: warmupStepCount + frameCount,
            message: "Writing frame..."
          });
        }
        const result = await writeExporter.finalize();
        kernel.store.getState().actions.setStatus(`Render finished. ${result.summary}`);
        viewport.stop();
        viewport = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown render failure";
        kernel.store.getState().actions.setStatus(`Render failed: ${message}`);
        if (exporter) {
          await exporter.abort().catch(() => undefined);
        }
      } finally {
        if (viewport) {
          viewport.stop();
        }
        kernel.store.getState().actions.setCameraState(previousCamera, false);
        kernel.store.getState().actions.setElapsedSimSeconds(previousTime.elapsedSimSeconds);
        kernel.store.getState().actions.setTimeRunning(previousTime.running);
        kernel.store.getState().actions.setTimeSpeed(previousTime.speed);
        setMainViewportSuspended(false);
        setRenderOverlayOpen(false);
        setRenderProgress(null);
      }
    },
    [activeProjectName, cameraPathActors, kernel, sceneAntialiasing, sceneRenderEngine]
  );

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
          const report = await discoverAndLoadLocalPlugins(kernel);
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

  useEffect(
    () => () => {
      stopCameraTween();
    },
    [stopCameraTween]
  );

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
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        cycleCameraByTab(event.shiftKey ? -1 : 1);
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
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        stopCameraTween();
        const state = kernel.store.getState().state;
        const nextMode = state.camera.mode === "orthographic" ? "perspective" : "orthographic";
        actions.setCameraState({ mode: nextMode }, true);
        return;
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
  }, [activeSnapshotName, cycleCameraByTab, kernel, requestTextInput, stopCameraTween]);

  const topBar = useMemo(
    () => (
      <TopBarPanel
        onToggleKeyboardMap={() => setKeyboardMapOpen((value) => !value)}
        onOpenRender={() => setRenderModalOpen(true)}
        requestTextInput={requestTextInput}
      />
    ),
    [requestTextInput]
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
      />
      {dragImportState ? (
        <div className="file-drop-overlay">
          <div className="file-drop-overlay-head">
            <h2>Drop File To Import</h2>
            <p>{dragImportState.fileName || "Pending file import"}</p>
            <small>Release anywhere to open the import picker.</small>
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
      <RenderOverlay
        open={renderOverlayOpen}
        progress={renderProgress}
        onHostReady={handleRenderHostReady}
        onCancel={() => {
          renderCancelRequestedRef.current = true;
        }}
      />
    </div>
  );
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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

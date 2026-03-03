import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
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
import type { CameraState } from "@/core/types";

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
  const activeSessionName = useAppStore((store) => store.state.activeSessionName);
  const mode = useAppStore((store) => store.state.mode);
  const readOnly = mode === "web-ro";

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
          sessionName: activeSessionName
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown file import error";
        kernel.store.getState().actions.setStatus(`Unable to import ${input.fileName}: ${message}`);
      }
    },
    [activeSessionName, kernel]
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

  useEffect(() => {
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
      await kernel.sessionService.loadDefaultSession();
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
            title: "Save Session As",
            label: "Session name",
            initialValue: activeSessionName,
            confirmLabel: "Save"
          }).then((nextName) => {
            if (nextName) {
              void kernel.sessionService.saveAs(nextName);
            }
          });
          return;
        }
        void kernel.sessionService.saveSession();
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
  }, [activeSessionName, cycleCameraByTab, kernel, requestTextInput, stopCameraTween]);

  const topBar = useMemo(
    () => (
      <TopBarPanel
        onToggleKeyboardMap={() => setKeyboardMapOpen((value) => !value)}
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
      <FlexLayoutHost titleBar={titleBar} topBar={topBar} pendingDropFileName={dragImportState?.fileName ?? null} />
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
    </div>
  );
}

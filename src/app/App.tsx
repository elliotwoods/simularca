import { useCallback, useEffect, useMemo, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { registerCoreActorDescriptors, setupActorHotReload } from "@/features/actors/registerCoreActors";
import { FlexLayoutHost } from "@/ui/FlexLayoutHost";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";
import { TitleBarPanel } from "@/ui/panels/TitleBarPanel";
import { KeyboardMapModal } from "@/ui/components/KeyboardMapModal";
import { TextInputModal } from "@/ui/components/TextInputModal";

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
  const kernel = useKernel();
  const [keyboardMapOpen, setKeyboardMapOpen] = useState(false);
  const [textInputRequest, setTextInputRequest] = useState<{
    title: string;
    label: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const activeSessionName = useAppStore((store) => store.state.activeSessionName);

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
    void kernel.sessionService.loadDefaultSession();
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
        actions.deleteSelection();
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
  }, [activeSessionName, kernel, requestTextInput]);

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
    <div className="app-root">
      <FlexLayoutHost titleBar={titleBar} topBar={topBar} />
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

import { useEffect, useRef, useState } from "react";
import type { RotoControlBank, RotoControlDawEmulation, RotoControlInputEvent, RotoControlState } from "@/types/ipc";
import { equalRotoBanks } from "@/features/rotoControl/utils";

export const ROTO_CONTROL_SERIAL_OVERRIDE_STORAGE_KEY = "simularca:roto-control:serial-port-override";
export const ROTO_CONTROL_DAW_EMULATION_STORAGE_KEY = "simularca:roto-control:daw-emulation";

interface UseRotoControlBankOptions {
  active: boolean;
  bank: RotoControlBank | null;
  onInput: (event: RotoControlInputEvent) => void;
}

const DEFAULT_STATE: RotoControlState = {
  available: false,
  midiConnected: false,
  serialConnected: false,
  sysexConnected: false,
  lastError: null,
  inputMode: "plugin",
  connectionPhase: "disconnected",
  requiredDeviceMode: "plugin",
  statusSummary: "Roto-Control is not connected.",
  setupInstructions: [],
  midiInputPortName: null,
  midiOutputPortName: null,
  serialPortPath: null,
  serialDiscoveryMode: "auto",
  serialPortOverridePath: null,
  serialSelectionReason: "No compatible Roto serial ports detected.",
  serialCandidates: [],
  dawEmulation: "ableton",
  serialAdminState: "idle",
  lastProvisionedSignature: null,
  lastProvisionAttemptAtIso: null,
  lastSerialResponseCode: null,
  lastSerialRequestType: null,
  usingCachedProvisionedDefinition: false,
  lastPublishedBankTitle: null,
  lastPublishedBankContextPath: null,
  lastPublishedBankPageIndex: null,
  lastPublishedSlotLabels: [],
  lastPublishedAtIso: null
};

interface UseRotoControlStateOptions {
  activeInput?: boolean;
  onInput?: (event: RotoControlInputEvent) => void;
}

export function getStoredRotoControlSerialOverride(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(ROTO_CONTROL_SERIAL_OVERRIDE_STORAGE_KEY);
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function persistRotoControlSerialOverride(path: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (path?.trim()) {
      window.localStorage.setItem(ROTO_CONTROL_SERIAL_OVERRIDE_STORAGE_KEY, path.trim());
      return;
    }
    window.localStorage.removeItem(ROTO_CONTROL_SERIAL_OVERRIDE_STORAGE_KEY);
  } catch {
    // Ignore persistence failures and keep the runtime override only.
  }
}

export function getStoredRotoControlDawEmulation(): RotoControlDawEmulation {
  if (typeof window === "undefined") {
    return "ableton";
  }
  try {
    const value = window.localStorage.getItem(ROTO_CONTROL_DAW_EMULATION_STORAGE_KEY);
    return value === "bitwig" ? "bitwig" : "ableton";
  } catch {
    return "ableton";
  }
}

export function persistRotoControlDawEmulation(mode: RotoControlDawEmulation): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ROTO_CONTROL_DAW_EMULATION_STORAGE_KEY, mode);
  } catch {
    // Ignore persistence failures and keep the runtime setting only.
  }
}

export function useRotoControlState(options: UseRotoControlStateOptions = {}): RotoControlState {
  const onInputRef = useRef<((event: RotoControlInputEvent) => void) | undefined>(options.onInput);
  const activeInputRef = useRef(options.activeInput);
  const [state, setState] = useState<RotoControlState>(DEFAULT_STATE);

  onInputRef.current = options.onInput;
  activeInputRef.current = options.activeInput;

  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi?.rotoControlConnect) {
      return;
    }
    let disposed = false;
    const unsubscribeState = electronApi.onRotoControlState?.((next) => {
      if (!disposed) {
        setState(next);
      }
    });
    const unsubscribeInput = electronApi.onRotoControlInput?.((event) => {
      if (!disposed && activeInputRef.current) {
        onInputRef.current?.(event);
      }
    });
    void (async () => {
      try {
        if (electronApi?.rotoControlSetDawEmulation) {
          const next = await electronApi.rotoControlSetDawEmulation(getStoredRotoControlDawEmulation());
          if (!disposed) {
            setState(next);
          }
        }
        if (electronApi?.rotoControlSetSerialOverride) {
          const next = await electronApi.rotoControlSetSerialOverride(getStoredRotoControlSerialOverride());
          if (!disposed) {
            setState(next);
          }
        }
        const next = await electronApi.rotoControlConnect();
        if (!disposed) {
          setState(next);
        }
      } catch (error) {
        if (!disposed) {
          setState((current) => ({
            ...current,
            lastError: error instanceof Error ? error.message : String(error)
          }));
        }
      }
    })();
    return () => {
      disposed = true;
      unsubscribeState?.();
      unsubscribeInput?.();
    };
  }, [options.activeInput]);

  return state;
}

export function useRotoControlBank(options: UseRotoControlBankOptions): RotoControlState {
  const bankRef = useRef<RotoControlBank | null>(null);
  const suppressInputUntilRef = useRef(0);
  const [publishError, setPublishError] = useState<string | null>(null);
  const state = useRotoControlState({
    activeInput: options.active,
    onInput: (event) => {
      if (!options.active) {
        return;
      }
      const activeBank = bankRef.current;
      if (!activeBank) {
        return;
      }
      if (event.contextPath && event.contextPath !== activeBank.contextPath) {
        return;
      }
      if (Date.now() < suppressInputUntilRef.current && event.type !== "raw-midi") {
        return;
      }
      options.onInput(event);
    }
  });

  useEffect(() => {
    if (!options.active || !options.bank || !window.electronAPI?.rotoControlPublishBank) {
      return;
    }
    if (equalRotoBanks(bankRef.current, options.bank)) {
      return;
    }
    const bankIdentityChanged =
      bankRef.current?.contextPath !== options.bank.contextPath || bankRef.current?.pageIndex !== options.bank.pageIndex;
    bankRef.current = options.bank;
    if (bankIdentityChanged) {
      suppressInputUntilRef.current = Date.now() + 150;
    }
    void window.electronAPI.rotoControlPublishBank(options.bank)
      .then(() => {
        setPublishError(null);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setPublishError(message);
      });
  }, [options.active, options.bank]);

  if (!publishError) {
    return state;
  }
  return {
    ...state,
    lastError: publishError
  };
}

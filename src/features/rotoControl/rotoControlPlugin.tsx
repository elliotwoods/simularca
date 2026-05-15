import { useCallback, useEffect, useMemo, useState } from "react";
import { useKernel } from "@/app/useKernel";
import {
  buildRotoBank,
  createRotoActionBinding,
  createRotoDisplayBinding,
  createRotoEnumBinding,
  type RotoBinding
} from "@/features/rotoControl/bankBindings";
import {
  persistRotoControlDawEmulation,
  persistRotoControlSerialOverride,
  useRotoControlBank,
  useRotoControlState
} from "@/features/rotoControl/useRotoControlBank";
import type { RotoControlDawEmulation, RotoControlState } from "@/features/rotoControl/types";
import type {
  PluginDefinitionInput,
  PluginInspectorComponentProps,
  PluginRotoControlComponentProps,
  PluginRuntimeComponentProps
} from "@/features/plugins/pluginApi";
import { StatsBlock } from "@/ui/components/StatsBlock";
import type { StatsGroup, StatsRow, StatsTone } from "@/ui/components/StatsBlock";

const AUTO_SERIAL_OVERRIDE_VALUE = "__auto__";

function RotoControlRuntime(_props: PluginRuntimeComponentProps) {
  useRotoControlState();
  return null;
}

interface RotoControlControllerActions {
  refresh: () => void | Promise<void>;
  setSerialOverride: (path: string | null) => void | Promise<void>;
}

function getRotoSerialOptionValues(state: RotoControlState): string[] {
  const values = ["Auto", ...state.serialCandidates.map((candidate) => candidate.path)];
  if (state.serialPortOverridePath && !values.includes(state.serialPortOverridePath)) {
    values.push(state.serialPortOverridePath);
  }
  return values;
}

function getPreferredManualSerialPath(state: RotoControlState): string | null {
  return (
    state.serialPortOverridePath ??
    state.serialCandidates.find((candidate) => candidate.selected)?.path ??
    state.serialPortPath ??
    state.serialCandidates[0]?.path ??
    null
  );
}

export function buildRotoControlControllerBindings(
  state: RotoControlState,
  actions: RotoControlControllerActions
): RotoBinding[] {
  const serialPortOptions = getRotoSerialOptionValues(state);
  const selectedManualPath = getPreferredManualSerialPath(state);
  const currentSerialPortValue = state.serialPortOverridePath ?? "Auto";
  const statusBindings: RotoBinding[] = [
    createRotoDisplayBinding("roto-session", "DAW Session", state.sysexConnected ? "Connected" : "Waiting"),
    createRotoDisplayBinding("roto-phase", "Phase", state.connectionPhase),
    createRotoDisplayBinding("roto-midi-in", "MIDI In", state.midiInputPortName ?? "Not detected"),
    createRotoDisplayBinding("roto-midi-out", "MIDI Out", state.midiOutputPortName ?? "Not detected"),
    createRotoDisplayBinding("roto-serial-port", "Serial", state.serialPortPath ?? "Optional"),
    createRotoDisplayBinding("roto-required-mode", "Mode", "PLUGIN"),
    createRotoActionBinding("roto-reconnect", "Reconnect", "action", () => {
      void actions.refresh();
    }),
    createRotoDisplayBinding("roto-status", "Status", state.statusSummary)
  ];
  const serialBindings: RotoBinding[] = [
    createRotoEnumBinding(
      "roto-serial-mode",
      "Serial Mode",
      ["Auto", "Manual"],
      state.serialDiscoveryMode === "manual" ? "Manual" : "Auto",
      (next) => {
        if (next === "Auto") {
          void actions.setSerialOverride(null);
          return;
        }
        void actions.setSerialOverride(selectedManualPath);
      }
    ),
    createRotoEnumBinding(
      "roto-serial-selection",
      "Serial Port",
      serialPortOptions,
      currentSerialPortValue,
      (next) => {
        void actions.setSerialOverride(next === "Auto" ? null : next);
      },
      "enum",
      serialPortOptions.length <= 1
    ),
    createRotoDisplayBinding("roto-selected-port", "Selected", state.serialPortPath ?? "None"),
    createRotoDisplayBinding("roto-selection-reason", "Reason", state.serialSelectionReason),
    createRotoDisplayBinding(
      "roto-candidates",
      "Candidates",
      state.serialCandidates.length > 0 ? state.serialCandidates.map((candidate) => candidate.path).join(", ") : "None"
    ),
    createRotoDisplayBinding("roto-override", "Override", state.serialPortOverridePath ?? "Auto"),
    createRotoDisplayBinding("roto-input-mode", "Input Mode", state.inputMode.toUpperCase()),
    createRotoDisplayBinding("roto-serial-state", "Serial State", state.serialConnected ? "Connected" : "Optional")
  ];
  const diagnosticsBindings = state.lastError
    ? [
        createRotoDisplayBinding("roto-diagnostics-status", "Status", state.statusSummary),
        createRotoDisplayBinding("roto-diagnostics-error", "Error", state.lastError)
      ]
    : [];
  return [...statusBindings, ...serialBindings, ...diagnosticsBindings];
}

function RotoControlController(_props: PluginRotoControlComponentProps) {
  const state = useRotoControlState();
  const [pageIndex, setPageIndex] = useState(0);

  const handleRefresh = useCallback(() => {
    if (!window.electronAPI?.rotoControlRefresh) {
      return;
    }
    void window.electronAPI.rotoControlRefresh();
  }, []);

  const handleSetSerialOverride = useCallback((path: string | null) => {
    persistRotoControlSerialOverride(path);
    if (!window.electronAPI?.rotoControlSetSerialOverride) {
      return;
    }
    void window.electronAPI.rotoControlSetSerialOverride(path);
  }, []);

  const bindings = useMemo(
    () =>
      buildRotoControlControllerBindings(state, {
        refresh: handleRefresh,
        setSerialOverride: handleSetSerialOverride
      }),
    [handleRefresh, handleSetSerialOverride, state]
  );
  const bankState = useMemo(
    () => buildRotoBank("Roto-Control", "plugin:plugin.rotoControl", pageIndex, bindings),
    [bindings, pageIndex]
  );

  useEffect(() => {
    setPageIndex((current) => Math.max(0, Math.min(current, bankState.pageCount - 1)));
  }, [bankState.pageCount]);

  useRotoControlBank({
    active: true,
    bank: bankState.bank,
    onInput: (event) => {
      if (event.type === "page-select") {
        setPageIndex(Math.max(0, Math.min(bankState.pageCount - 1, event.pageIndex)));
        return;
      }
      if (event.type === "page-next") {
        setPageIndex((current) => Math.min(bankState.pageCount - 1, current + 1));
        return;
      }
      if (event.type === "page-prev") {
        setPageIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (event.type === "encoder-turn") {
        bankState.pageBindings[event.slotIndex]?.onTurn?.(event.delta);
        return;
      }
      if (event.type === "encoder-set") {
        const binding = bankState.pageBindings[event.slotIndex];
        if (binding?.onSetNormalized) {
          binding.onSetNormalized(event.normalizedValue);
          return;
        }
        if (typeof event.delta === "number" && event.delta !== 0) {
          binding?.onTurn?.(event.delta);
        }
        return;
      }
      if (event.type === "button-press") {
        bankState.pageBindings[event.slotIndex]?.onPress?.();
      }
    }
  });

  return null;
}

export function buildRotoControlStatusGroups(state: RotoControlState): { rows: StatsRow[]; groups: StatsGroup[] } {
  const sessionTone: StatsTone = state.connectionPhase === "connected" ? "default" : "warning";
  const dawSessionTone: StatsTone = state.sysexConnected ? "default" : "warning";
  const groups: StatsGroup[] = [
    {
      label: "Session",
      rows: [
        { label: "Status", value: state.statusSummary, tone: sessionTone },
        { label: "Connection Phase", value: state.connectionPhase, tone: sessionTone },
        { label: "DAW Session", value: state.sysexConnected ? "Connected" : "Waiting", tone: dawSessionTone }
      ]
    },
    {
      label: "Ports",
      rows: [
        { label: "MIDI Input", value: state.midiInputPortName ?? "Not detected" },
        { label: "MIDI Output", value: state.midiOutputPortName ?? "Not detected" },
        { label: "Serial Port", value: state.serialPortPath ?? "Optional / not detected" },
        { label: "Serial Selection", value: state.serialSelectionReason },
        { label: "DAW Emulation", value: state.dawEmulation === "bitwig" ? "Bitwig" : "Ableton" }
      ]
    },
    {
      label: "Serial Admin",
      rows: [
        { label: "Admin State", value: state.serialAdminState },
        { label: "Using Cached Config", value: state.usingCachedProvisionedDefinition ? "Yes" : "No" },
        { label: "Last Signature", value: state.lastProvisionedSignature ?? "n/a" },
        { label: "Last Attempt", value: state.lastProvisionAttemptAtIso ? new Date(state.lastProvisionAttemptAtIso).toLocaleString() : "n/a" },
        { label: "Last Response", value: state.lastSerialResponseCode ?? "n/a" },
        { label: "Last Request", value: state.lastSerialRequestType ?? "n/a" }
      ]
    },
    {
      label: "Publishing",
      rows: [
        { label: "Last Bank", value: state.lastPublishedBankTitle ?? "No bank published yet" },
        { label: "Last Context", value: state.lastPublishedBankContextPath ?? "n/a" },
        { label: "Last Page", value: state.lastPublishedBankPageIndex !== null && state.lastPublishedBankPageIndex !== undefined ? String(state.lastPublishedBankPageIndex + 1) : "n/a" },
        {
          label: "Last Slots",
          value: state.lastPublishedSlotLabels && state.lastPublishedSlotLabels.length > 0 ? state.lastPublishedSlotLabels.join(", ") : "n/a"
        },
        { label: "Last Publish", value: state.lastPublishedAtIso ? new Date(state.lastPublishedAtIso).toLocaleString() : "n/a" }
      ]
    }
  ];
  if (state.lastError) {
    groups.push({
      label: "Diagnostics",
      rows: [{ label: "Last Error", value: state.lastError, tone: "error" }]
    });
  }
  return { rows: [], groups };
}

function RotoControlInspector(props: PluginInspectorComponentProps) {
  const kernel = useKernel();
  const state = useRotoControlState();
  const [refreshing, setRefreshing] = useState(false);
  const [updatingSerialOverride, setUpdatingSerialOverride] = useState(false);
  const [updatingDawEmulation, setUpdatingDawEmulation] = useState(false);
  const statusBlock = buildRotoControlStatusGroups(state);
  const serialOverrideValue = state.serialPortOverridePath ?? AUTO_SERIAL_OVERRIDE_VALUE;
  const serialCandidateSummary =
    state.serialCandidates.length > 0
      ? state.serialCandidates.map((candidate) => candidate.path).join(", ")
      : "No compatible serial ports detected.";

  useEffect(() => {
    if (state.lastError) {
      kernel.store.getState().actions.addLog({
        level: "warn",
        message: "Roto-Control warning",
        details: state.lastError
      });
    }
  }, [kernel, state.lastError]);

  const handleRefresh = async () => {
    if (!window.electronAPI?.rotoControlRefresh) {
      return;
    }
    setRefreshing(true);
    try {
      await window.electronAPI.rotoControlRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleSerialOverrideChange = async (value: string) => {
    const nextOverride = value === AUTO_SERIAL_OVERRIDE_VALUE ? null : value;
    persistRotoControlSerialOverride(nextOverride);
    if (!window.electronAPI?.rotoControlSetSerialOverride) {
      return;
    }
    setUpdatingSerialOverride(true);
    try {
      await window.electronAPI.rotoControlSetSerialOverride(nextOverride);
    } finally {
      setUpdatingSerialOverride(false);
    }
  };

  const handleDawEmulationChange = async (value: string) => {
    const nextMode: RotoControlDawEmulation = value === "bitwig" ? "bitwig" : "ableton";
    persistRotoControlDawEmulation(nextMode);
    if (!window.electronAPI?.rotoControlSetDawEmulation) {
      return;
    }
    setUpdatingDawEmulation(true);
    try {
      await window.electronAPI.rotoControlSetDawEmulation(nextMode);
    } finally {
      setUpdatingDawEmulation(false);
    }
  };

  return (
    <div className="inspector-pane-root custom-inspector">
      <section className="inspector-common-card">
        <header className="inspector-card-header">
          <h4>{props.plugin.manifest?.name ?? props.plugin.definition.name}</h4>
          <button type="button" onClick={() => void handleRefresh()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Reconnect"}
          </button>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Required Mode</span>
            <span className="inspector-scene-value">PLUGIN</span>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Serial Mode</span>
            <span className="inspector-scene-value">
              {state.serialDiscoveryMode === "manual" ? "Manual override" : "Auto"}
            </span>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">DAW Emulation</span>
            <div className="inspector-common-control-wrap">
              <select
                className="widget-select"
                value={state.dawEmulation}
                disabled={updatingDawEmulation}
                onChange={(event) => {
                  void handleDawEmulationChange(event.target.value);
                }}
              >
                <option value="ableton">Ableton</option>
                <option value="bitwig">Bitwig</option>
              </select>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Serial Port</span>
            <div className="inspector-common-control-wrap">
              <select
                className="widget-select"
                value={serialOverrideValue}
                disabled={updatingSerialOverride}
                onChange={(event) => {
                  void handleSerialOverrideChange(event.target.value);
                }}
              >
                <option value={AUTO_SERIAL_OVERRIDE_VALUE}>Auto-detect</option>
                {state.serialCandidates.map((candidate) => (
                  <option key={candidate.path} value={candidate.path}>
                    {candidate.path}
                    {candidate.selected ? " (selected)" : ""}
                  </option>
                ))}
                {state.serialPortOverridePath && !state.serialCandidates.some((candidate) => candidate.path === state.serialPortOverridePath) ? (
                  <option value={state.serialPortOverridePath}>
                    {state.serialPortOverridePath} (unavailable)
                  </option>
                ) : null}
              </select>
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Detected Ports</span>
            <span className="inspector-scene-value">{serialCandidateSummary}</span>
          </div>
        </div>
      </section>

      <StatsBlock
        title="Status"
        className="inspector-debug-card"
        titleLevel="h4"
        emptyText="No status available."
        rows={statusBlock.rows}
        groups={statusBlock.groups}
        onCopySuccess={(label) => {
          kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
        }}
        onCopyError={(label, message) => {
          kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
        }}
      />

      <section className="inspector-debug-card">
        <header>
          <h4>Setup</h4>
        </header>
        <div className="roto-plugin-setup">
          {state.setupInstructions.map((instruction, index) => (
            <p key={`${instruction}-${index}`}>{instruction}</p>
          ))}
        </div>
        <p className="panel-empty">
          If the device is visible but not responding, leave it in PLUGIN mode. MIDI mode and MIX mode will not complete the
          DAW handshake this integration expects.
        </p>
      </section>
    </div>
  );
}

export function createRotoControlPlugin(): PluginDefinitionInput {
  return {
    id: "plugin.rotoControl",
    name: "Roto-Control",
    actorDescriptors: [],
    componentDescriptors: [],
    viewDescriptors: [],
    inspectorComponent: RotoControlInspector,
    rotoControlComponent: RotoControlController,
    runtimeComponent: RotoControlRuntime
  };
}

export function augmentRotoControlPluginDefinition(plugin: PluginDefinitionInput): PluginDefinitionInput {
  const appPlugin = createRotoControlPlugin();
  return {
    ...plugin,
    viewDescriptors: [...(plugin.viewDescriptors ?? []), ...(appPlugin.viewDescriptors ?? [])],
    inspectorComponent: appPlugin.inspectorComponent,
    rotoControlComponent: appPlugin.rotoControlComponent,
    runtimeComponent: appPlugin.runtimeComponent
  };
}

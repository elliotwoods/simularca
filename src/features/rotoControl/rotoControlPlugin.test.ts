import { describe, expect, it, vi } from "vitest";
import type { RotoControlState } from "@/features/rotoControl/types";
import {
  buildRotoControlControllerBindings,
  buildRotoControlStatusGroups
} from "@/features/rotoControl/rotoControlPlugin";

function createState(overrides: Partial<RotoControlState> = {}): RotoControlState {
  return {
    available: true,
    midiConnected: true,
    serialConnected: true,
    sysexConnected: true,
    lastError: null,
    inputMode: "plugin",
    connectionPhase: "connected",
    requiredDeviceMode: "plugin",
    statusSummary: "Connected",
    setupInstructions: [],
    midiInputPortName: "Roto Control DAW In",
    midiOutputPortName: "Roto Control DAW Out",
    serialPortPath: "COM4",
    serialDiscoveryMode: "auto",
    serialPortOverridePath: null,
    serialSelectionReason: "Auto-selected COM4 from 2 matching Roto serial ports.",
    serialCandidates: [
      { path: "COM4", friendlyName: "USB Serial Device (COM4)", vendorId: "2E8A", productId: "F010", selected: true },
      { path: "COM3", friendlyName: "USB Serial Device (COM3)", vendorId: "2E8A", productId: "F010", selected: false }
    ],
    dawEmulation: "ableton",
    serialAdminState: "ready",
    lastProvisionedSignature: "abc123def456",
    lastProvisionAttemptAtIso: "2026-04-01T08:00:01.000Z",
    lastSerialResponseCode: null,
    lastSerialRequestType: null,
    usingCachedProvisionedDefinition: true,
    lastPublishedBankTitle: "Roto-Control",
    lastPublishedBankContextPath: "plugin:plugin.rotoControl",
    lastPublishedBankPageIndex: 0,
    lastPublishedSlotLabels: ["DAW Session", "Phase"],
    lastPublishedAtIso: "2026-04-01T08:00:00.000Z",
    ...overrides
  };
}

describe("roto control plugin status mapping", () => {
  it("builds grouped status rows for a healthy connection", () => {
    const result = buildRotoControlStatusGroups(createState());

    expect(result.rows).toEqual([]);
    expect(result.groups).toHaveLength(4);
    expect(result.groups[0]).toEqual({
      label: "Session",
      rows: [
        { label: "Status", value: "Connected", tone: "default" },
        { label: "Connection Phase", value: "connected", tone: "default" },
        { label: "DAW Session", value: "Connected", tone: "default" }
      ]
    });
    expect(result.groups[1]).toEqual({
      label: "Ports",
      rows: [
        { label: "MIDI Input", value: "Roto Control DAW In" },
        { label: "MIDI Output", value: "Roto Control DAW Out" },
        { label: "Serial Port", value: "COM4" },
        { label: "Serial Selection", value: "Auto-selected COM4 from 2 matching Roto serial ports." },
        { label: "DAW Emulation", value: "Ableton" }
      ]
    });
    expect(result.groups[2]).toEqual({
      label: "Serial Admin",
      rows: [
        { label: "Admin State", value: "ready" },
        { label: "Using Cached Config", value: "Yes" },
        { label: "Last Signature", value: "abc123def456" },
        { label: "Last Attempt", value: new Date("2026-04-01T08:00:01.000Z").toLocaleString() },
        { label: "Last Response", value: "n/a" },
        { label: "Last Request", value: "n/a" }
      ]
    });
    expect(result.groups[3]?.label).toBe("Publishing");
    expect(result.groups[3]?.rows[0]).toEqual({ label: "Last Bank", value: "Roto-Control" });
  });

  it("marks waiting session rows as warnings", () => {
    const result = buildRotoControlStatusGroups(
      createState({
        sysexConnected: false,
        connectionPhase: "waiting-for-ping",
        statusSummary: "Waiting for Roto-Control handshake"
      })
    );

    expect(result.groups[0]).toEqual({
      label: "Session",
      rows: [
        { label: "Status", value: "Waiting for Roto-Control handshake", tone: "warning" },
        { label: "Connection Phase", value: "waiting-for-ping", tone: "warning" },
        { label: "DAW Session", value: "Waiting", tone: "warning" }
      ]
    });
  });

  it("surfaces the last error in a diagnostics group", () => {
    const result = buildRotoControlStatusGroups(
      createState({
        connectionPhase: "disconnected",
        sysexConnected: false,
        lastError: "Broken serial handshake"
      })
    );

    expect(result.groups[4]).toEqual({
      label: "Diagnostics",
      rows: [{ label: "Last Error", value: "Broken serial handshake", tone: "error" }]
    });
  });

  it("builds controller pages for plugin-selected roto status and serial controls", () => {
    const bindings = buildRotoControlControllerBindings(createState(), {
      refresh: vi.fn(),
      setSerialOverride: vi.fn()
    });

    expect(bindings).toHaveLength(16);
    expect(bindings[0]?.slot.label).toBe("DAW Sessi");
    expect(bindings[0]?.slot.valueText).toBe("Connected");
    expect(bindings[6]?.slot.label).toBe("Reconnect");
    expect(bindings[8]?.slot.label).toBe("Serial Mode");
    expect(bindings[9]?.slot.label).toBe("Serial Port");
    expect(bindings[10]?.slot.valueText).toBe("COM4");
  });

  it("maps controller serial actions onto override changes", () => {
    const refresh = vi.fn();
    const setSerialOverride = vi.fn();
    const bindings = buildRotoControlControllerBindings(createState(), {
      refresh,
      setSerialOverride
    });

    bindings[6]?.onPress?.();
    bindings[8]?.onTurn?.(1);
    bindings[9]?.onTurn?.(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(setSerialOverride).toHaveBeenNthCalledWith(1, "COM4");
    expect(setSerialOverride).toHaveBeenNthCalledWith(2, "COM4");
  });

  it("adds diagnostics controller bindings only when an error is present", () => {
    const bindings = buildRotoControlControllerBindings(
      createState({
        lastError: "Broken serial handshake"
      }),
      {
        refresh: vi.fn(),
        setSerialOverride: vi.fn()
      }
    );

    expect(bindings).toHaveLength(18);
    expect(bindings[17]?.slot.label).toBe("Error");
    expect(bindings[17]?.slot.valueText).toBe("Broken serial handshake");
  });
});

import { describe, expect, it } from "vitest";
import type { RotoControlInputEvent } from "../src/types/ipc";
import {
  buildLearnParamMessage,
  RotoControlHost,
  scoreMatchingPortName,
  scoreSerialCandidate,
  selectSerialPort
} from "./rotoControlHost";

class FakeMidiInput {
  public static instances: FakeMidiInput[] = [];
  private listener: ((deltaTime: number, message: number[]) => void) | null = null;

  public constructor() {
    FakeMidiInput.instances.push(this);
  }

  public getPortCount(): number {
    return 1;
  }

  public getPortName(): string {
    return "ROTO CONTROL DAW";
  }

  public openPort(): void {}

  public closePort(): void {}

  public ignoreTypes(): void {}

  public on(_event: "message", listener: (deltaTime: number, message: number[]) => void): void {
    this.listener = listener;
  }

  public removeAllListeners(): void {
    this.listener = null;
  }

  public emitMessage(message: number[]): void {
    this.listener?.(0, message);
  }
}

class FakeMidiOutput {
  public static sentMessagesGlobal: number[][] = [];
  public sentMessages: number[][] = [];

  public getPortCount(): number {
    return 1;
  }

  public getPortName(): string {
    return "ROTO CONTROL DAW";
  }

  public openPort(): void {}

  public closePort(): void {}

  public sendMessage(message: number[]): void {
    this.sentMessages.push(message);
    FakeMidiOutput.sentMessagesGlobal.push(message);
  }
}

class FakeSerialPort {
  public static openedPaths: string[] = [];
  public static writtenPayloads: number[][] = [];

  private readonly listeners: Record<string, Array<(...args: any[]) => void>> = {
    open: [],
    data: [],
    error: [],
    close: []
  };

  public constructor(options: { path: string }) {
    FakeSerialPort.openedPaths.push(options.path);
    queueMicrotask(() => {
      this.emit("open");
    });
  }

  public write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void {
    const payload = Buffer.isBuffer(data) ? [...data] : Array.from(data);
    FakeSerialPort.writtenPayloads.push(payload);
    callback?.(null);
    const command = payload[1] ?? 0;
    const subCommand = payload[2] ?? 0;
    let response = Buffer.from([0xa5, 0x00]);
    if (command === 0x03 && subCommand === 0x04) {
      response = Buffer.from([0xa5, 0xfd]);
    }
    queueMicrotask(() => {
      this.emit("data", response);
    });
  }

  public close(callback?: (error?: Error | null) => void): void {
    callback?.(null);
  }

  public on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void {
    this.listeners[event] ??= [];
    this.listeners[event].push(listener);
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(...args);
    }
  }
}

class RejectingSerialPort {
  public static openedPaths: string[] = [];
  public static writtenPayloads: number[][] = [];

  private readonly listeners: Record<string, Array<(...args: any[]) => void>> = {
    open: [],
    data: [],
    error: [],
    close: []
  };

  public constructor(options: { path: string }) {
    RejectingSerialPort.openedPaths.push(options.path);
    queueMicrotask(() => {
      this.emit("open");
    });
  }

  public write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void {
    const payload = Buffer.isBuffer(data) ? [...data] : Array.from(data);
    RejectingSerialPort.writtenPayloads.push(payload);
    callback?.(null);
    queueMicrotask(() => {
      this.emit("data", Buffer.from([0xa5, 0xfb]));
    });
  }

  public close(callback?: (error?: Error | null) => void): void {
    callback?.(null);
  }

  public on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void {
    this.listeners[event] ??= [];
    this.listeners[event].push(listener);
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(...args);
    }
  }
}

function createImmediateTimeout(callback: () => void): ReturnType<typeof setTimeout> {
  queueMicrotask(callback);
  return 1 as unknown as ReturnType<typeof setTimeout>;
}

async function flushAsyncWork(turns = 250): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

describe("rotoControlHost", () => {
  it("prefers DAW-labelled MIDI ports during discovery", () => {
    expect(scoreMatchingPortName("ROTO CONTROL DAW")).toBeGreaterThan(scoreMatchingPortName("ROTO CONTROL"));
    expect(scoreMatchingPortName("Some Other Device")).toBeLessThan(0);
  });

  it("scores generic Windows serial ports by VID/PID and interface number", () => {
    expect(
      scoreSerialCandidate({
        path: "COM4",
        friendlyName: "USB Serial Device (COM4)",
        vendorId: "2E8A",
        productId: "F010",
        pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
      })
    ).toBeGreaterThan(
      scoreSerialCandidate({
        path: "COM3",
        friendlyName: "USB Serial Device (COM3)",
        vendorId: "2E8A",
        productId: "F010",
        pnpId: "USB\\VID_2E8A&PID_F010&MI_02\\ABC"
      })
    );
  });

  it("auto-selects the best matching serial port and supports manual override", () => {
    const ports = [
      {
        path: "COM3",
        friendlyName: "USB Serial Device (COM3)",
        vendorId: "2E8A",
        productId: "F010",
        pnpId: "USB\\VID_2E8A&PID_F010&MI_02\\ABC"
      },
      {
        path: "COM4",
        friendlyName: "USB Serial Device (COM4)",
        vendorId: "2E8A",
        productId: "F010",
        pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
      }
    ];

    const autoSelection = selectSerialPort(ports, null);
    expect(autoSelection.selected?.entry.path).toBe("COM4");
    expect(autoSelection.reason).toContain("Auto-selected COM4");

    const manualSelection = selectSerialPort(ports, "COM3");
    expect(manualSelection.selected?.entry.path).toBe("COM3");
    expect(manualSelection.reason).toBe("Using manual serial override COM3.");
    expect(manualSelection.candidates.find((candidate) => candidate.path === "COM3")?.selected).toBe(true);
  });

  it("keeps a connected DAW session coherent across reconnect attempts", async () => {
    FakeMidiOutput.sentMessagesGlobal = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => null,
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval
      }
    );

    await host.connect();
    expect(host.getState().lastError).toBeNull();

    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0a,
      0x0c,
      0xf7
    ]);

    await host.connect();
    expect(host.getState().sysexConnected).toBe(true);
    expect(host.getState().connectionPhase).toBe("connected");
    expect(host.getState().lastError).toBeNull();
    expect(host.getState().statusSummary).toContain("plugin session is active");
  });

  it("applies a manual serial override through the host", async () => {
    FakeSerialPort.openedPaths = [];
    FakeSerialPort.writtenPayloads = [];
    FakeMidiOutput.sentMessagesGlobal = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => ({
          SerialPort: FakeSerialPort as unknown as new (options: {
            path: string;
            baudRate: number;
            autoOpen?: boolean;
          }) => {
            write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void;
            close(callback?: (error?: Error | null) => void): void;
            on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void;
          },
          list: async () => [
            {
              path: "COM3",
              friendlyName: "USB Serial Device (COM3)",
              vendorId: "2E8A",
              productId: "F010",
              pnpId: "USB\\VID_2E8A&PID_F010&MI_02\\ABC"
            },
            {
              path: "COM4",
              friendlyName: "USB Serial Device (COM4)",
              vendorId: "2E8A",
              productId: "F010",
              pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
            }
          ]
        }),
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval,
        setTimeout: createImmediateTimeout as typeof globalThis.setTimeout,
        clearTimeout: (() => {}) as typeof globalThis.clearTimeout
      }
    );

    await host.setSerialPortOverride("COM3");
    expect(host.getState().serialDiscoveryMode).toBe("manual");
    expect(host.getState().serialPortOverridePath).toBe("COM3");
    expect(host.getState().serialPortPath).toBe("COM3");
    expect(host.getState().serialSelectionReason).toBe("Using manual serial override COM3.");
  });

  it("provisions the active bank over serial and answers CONTROL_MAPPED", async () => {
    FakeMidiInput.instances = [];
    FakeSerialPort.openedPaths = [];
    FakeSerialPort.writtenPayloads = [];
    FakeMidiOutput.sentMessagesGlobal = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => ({
          SerialPort: FakeSerialPort as unknown as new (options: {
            path: string;
            baudRate: number;
            autoOpen?: boolean;
          }) => {
            write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void;
            close(callback?: (error?: Error | null) => void): void;
            on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void;
          },
          list: async () => [
            {
              path: "COM4",
              friendlyName: "USB Serial Device (COM4)",
              vendorId: "2E8A",
              productId: "F010",
              pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
            }
          ]
        }),
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval
      }
    );

    await host.publishBank({
      title: "Actor A",
      contextPath: "actor:test",
      pageIndex: 1,
      pageCount: 3,
      slots: Array.from({ length: 8 }, (_, index) => ({
        id: `slot-${index}`,
        label: `Slot ${index + 1}`,
        kind: "number" as const,
        colorRole: "default" as const,
        normalizedValue: index / 7
      }))
    });
    await flushAsyncWork();

    expect(host.getState().lastPublishedBankTitle).toBe("Actor A");

    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0a,
      0x0c,
      0xf7
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const sentBeforeMapped = FakeMidiOutput.sentMessagesGlobal.length;
    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0b,
      0x0b,
      0x00,
      0x00,
      0x46,
      0x11,
      0x53,
      0x6d,
      0x41,
      0x38,
      0x00,
      0x00,
      0x00,
      0x01,
      0xf7
    ]);

    expect(host.getState().connectionPhase).toBe("connected");
    expect(FakeMidiOutput.sentMessagesGlobal.length).toBeGreaterThanOrEqual(sentBeforeMapped);
  });

  it("does not reprovision serial when the bank signature is unchanged", async () => {
    FakeSerialPort.openedPaths = [];
    FakeSerialPort.writtenPayloads = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => null,
        loadSerialBindings: async () => ({
          SerialPort: FakeSerialPort as unknown as new (options: {
            path: string;
            baudRate: number;
            autoOpen?: boolean;
          }) => {
            write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void;
            close(callback?: (error?: Error | null) => void): void;
            on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void;
          },
          list: async () => [
            {
              path: "COM4",
              friendlyName: "USB Serial Device (COM4)",
              vendorId: "2E8A",
              productId: "F010",
              pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
            }
          ]
        }),
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval,
        setTimeout: createImmediateTimeout as typeof globalThis.setTimeout,
        clearTimeout: (() => {}) as typeof globalThis.clearTimeout
      }
    );

    const bank = {
      title: "Actor A",
      contextPath: "actor:test",
      pageIndex: 0,
      pageCount: 1,
      slots: Array.from({ length: 8 }, (_, index) => ({
        id: `slot-${index}`,
        label: `Slot ${index + 1}`,
        kind: "number" as const,
        colorRole: "default" as const,
        normalizedValue: index / 7
      }))
    };

    await host.publishBank(bank);
    await flushAsyncWork();
    const requestCountAfterFirstPublish = FakeSerialPort.writtenPayloads.length;

    await host.publishBank({
      ...bank,
      slots: bank.slots.map((slot, index) => ({
        ...slot,
        normalizedValue: 1 - index / 7
      }))
    });
    await flushAsyncWork();

    expect(FakeSerialPort.writtenPayloads.length).toBe(requestCountAfterFirstPublish);
    expect(host.getState().serialAdminState).toBe("ready");
    expect(host.getState().usingCachedProvisionedDefinition).toBe(true);
  });

  it("enters cooldown after a temporary serial admin rejection", async () => {
    RejectingSerialPort.openedPaths = [];
    RejectingSerialPort.writtenPayloads = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => null,
        loadSerialBindings: async () => ({
          SerialPort: RejectingSerialPort as unknown as new (options: {
            path: string;
            baudRate: number;
            autoOpen?: boolean;
          }) => {
            write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void;
            close(callback?: (error?: Error | null) => void): void;
            on(event: "data" | "open" | "error" | "close", listener: (...args: any[]) => void): void;
          },
          list: async () => [
            {
              path: "COM4",
              friendlyName: "USB Serial Device (COM4)",
              vendorId: "2E8A",
              productId: "F010",
              pnpId: "USB\\VID_2E8A&PID_F010&MI_00\\ABC"
            }
          ]
        }),
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval,
        setTimeout: createImmediateTimeout as typeof globalThis.setTimeout,
        clearTimeout: (() => {}) as typeof globalThis.clearTimeout
      }
    );

    const bank = {
      title: "Actor A",
      contextPath: "actor:test",
      pageIndex: 0,
      pageCount: 1,
      slots: Array.from({ length: 8 }, (_, index) => ({
        id: `slot-${index}`,
        label: `Slot ${index + 1}`,
        kind: "number" as const,
        colorRole: "default" as const,
        normalizedValue: index / 7
      }))
    };

    await host.publishBank(bank);
    await flushAsyncWork();
    const requestCountAfterFailure = RejectingSerialPort.writtenPayloads.length;

    expect(host.getState().serialAdminState).toBe("cooldown");
    expect(host.getState().lastSerialResponseCode).toBe("0xfb");
    expect(host.getState().lastSerialRequestType).toBe("start-config-update");

    await host.publishBank(bank);
    await flushAsyncWork();

    expect(RejectingSerialPort.writtenPayloads.length).toBe(requestCountAfterFailure);
    expect(host.getState().serialAdminState).toBe("cooldown");
  });

  it("emits plugin-mode input events from controller CCs and page-select sysex", async () => {
    FakeMidiInput.instances = [];
    const inputEvents: RotoControlInputEvent[] = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: (event) => inputEvents.push(event),
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => null,
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval
      }
    );

    await host.connect();
    const midiInput = FakeMidiInput.instances[0];
    expect(midiInput).toBeTruthy();

    midiInput?.emitMessage([0xbf, 12, 0x20]);
    midiInput?.emitMessage([0xbf, 44, 0x40]);
    midiInput?.emitMessage([0xbf, 20, 0x7f]);
    midiInput?.emitMessage([0xbf, 32, 0x7f]);
    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0b,
      0x08,
      0x00,
      0x02,
      0x00,
      0xf7
    ]);

    expect(inputEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "encoder-set", slotIndex: 0 }),
        expect.objectContaining({ type: "button-press", slotIndex: 0 }),
        expect.objectContaining({ type: "navigate-forward" }),
        expect.objectContaining({ type: "page-select", pageIndex: 2 })
      ])
    );
  });

  it("encodes learn-param sysex for quantized slots", () => {
    const message = buildLearnParamMessage(
      {
        id: "actor.translate.x",
        label: "Translate X",
        kind: "number",
        colorRole: "translate",
        normalizedValue: 0.5,
        quantizedStepCount: 5,
        stepLabels: ["-2", "-1", "0", "1", "2"]
      },
      9
    );

    expect(message.slice(0, 7)).toEqual([0xf0, 0x00, 0x22, 0x03, 0x02, 0x0b, 0x0a]);
    expect(message.at(-1)).toBe(0xf7);
    expect(message[7]).toBe(0x00);
    expect(message[8]).toBe(0x09);
    expect(message[16]).toBe(0x00);
    expect(message[17]).toBe(0x05);
    expect(message[18]).toBe(0x40);
    expect(message[19]).toBe(0x00);
  });

  it("suppresses quantized steps for centered slots", () => {
    const message = buildLearnParamMessage(
      {
        id: "actor.rotate.y",
        label: "Rotate Y",
        kind: "number",
        colorRole: "rotate",
        normalizedValue: 0.5,
        centered: true,
        quantizedStepCount: 7
      },
      1
    );

    expect(message[16]).toBe(0x01);
    expect(message[17]).toBe(0x00);
  });

  it("answers the DAW ping using the configured emulation", async () => {
    FakeMidiOutput.sentMessagesGlobal = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => null,
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval
      }
    );

    await host.connect();
    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0a,
      0x02,
      0xf7
    ]);

    expect(host.getState().dawEmulation).toBe("ableton");

    await host.setDawEmulation("bitwig");
    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0a,
      0x02,
      0xf7
    ]);

    expect(host.getState().dawEmulation).toBe("bitwig");
  });

  it("tracks the last published bank in host state", async () => {
    FakeMidiOutput.sentMessagesGlobal = [];
    const host = new RotoControlHost(
      {
        emitState: () => {},
        emitInput: () => {},
        log: () => {}
      },
      {
        loadMidiBindings: async () => ({
          input: FakeMidiInput,
          output: FakeMidiOutput
        }),
        loadSerialBindings: async () => null,
        setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
        clearInterval: (() => {}) as typeof globalThis.clearInterval
      }
    );

    await host.publishBank({
      title: "Roto-Control",
      contextPath: "plugin:plugin.rotoControl",
      pageIndex: 0,
      pageCount: 2,
      slots: [
        {
          id: "roto-session",
          label: "DAW Session",
          kind: "action",
          colorRole: "default"
        }
      ]
    });

    expect(host.getState().lastPublishedBankTitle).toBe("Roto-Control");
    expect(host.getState().lastPublishedBankContextPath).toBe("plugin:plugin.rotoControl");
    expect(host.getState().lastPublishedBankPageIndex).toBe(0);
    expect(host.getState().lastPublishedSlotLabels).toEqual(["DAW Session"]);
    expect(host.getState().lastPublishedAtIso).toBeTruthy();
    (host as unknown as { handleSysexMessage(message: number[]): void }).handleSysexMessage([
      0xf0,
      0x00,
      0x22,
      0x03,
      0x02,
      0x0a,
      0x0c,
      0xf7
    ]);
    expect(host.getState().connectionPhase).toBe("connected");
  });
});

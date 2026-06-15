// Dedicated Node subprocess that owns the @julusian/midi Input/Output handles.
//
// @julusian/midi's port enumeration (`getPortName`) and `openPort` are *synchronous*
// native calls. When a MIDI device or its driver is wedged, those calls block the
// calling thread forever. Running them here, in a forked child process, means a hang
// can never freeze the Electron main process: the parent (RotoControlHost) talks to
// this child over the fork IPC channel and, if a request times out, kills the child
// (which reliably reclaims a process blocked in a native call) and respawns it.
//
// Launched via `child_process.fork(..., { ELECTRON_RUN_AS_NODE: "1" })` so it runs as
// plain Node even inside Electron. See `createChildMidiEngine` in rotoControlHost.ts.

interface MidiInputNative {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  closePort(): void;
  ignoreTypes(sysex: boolean, timing: boolean, sensing: boolean): void;
  on(event: "message", listener: (deltaTime: number, message: number[]) => void): void;
}

interface MidiOutputNative {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  closePort(): void;
  sendMessage(message: number[]): void;
}

type ParentMessage =
  | { kind: "list"; id: number }
  | { kind: "open"; id: number; inputIndex: number; outputIndex: number }
  | { kind: "send"; message: number[] }
  | { kind: "close"; id: number };

function post(message: unknown): void {
  process.send?.(message);
}

function listNames(port: MidiInputNative | MidiOutputNative): string[] {
  const names: string[] = [];
  const count = port.getPortCount();
  for (let index = 0; index < count; index += 1) {
    names.push(port.getPortName(index));
  }
  return names;
}

async function main(): Promise<void> {
  let bindings: { Input: new () => MidiInputNative; Output: new () => MidiOutputNative };
  try {
    bindings = (await import("@julusian/midi")) as unknown as typeof bindings;
  } catch (error) {
    post({ kind: "loadFailed", error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const input = new bindings.Input();
  const output = new bindings.Output();
  let portsOpen = false;
  input.ignoreTypes(false, false, false);
  input.on("message", (_deltaTime, message) => {
    post({ kind: "midi", message });
  });

  process.on("message", (raw: ParentMessage) => {
    try {
      switch (raw.kind) {
        case "list":
          post({ kind: "result", id: raw.id, ok: true, data: { inputs: listNames(input), outputs: listNames(output) } });
          break;
        case "open":
          input.openPort(raw.inputIndex);
          output.openPort(raw.outputIndex);
          portsOpen = true;
          post({ kind: "result", id: raw.id, ok: true });
          break;
        case "send":
          if (portsOpen) {
            output.sendMessage(raw.message);
          }
          break;
        case "close":
          try {
            input.closePort();
          } catch {
            /* ignore */
          }
          try {
            output.closePort();
          } catch {
            /* ignore */
          }
          portsOpen = false;
          post({ kind: "result", id: raw.id, ok: true });
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ("id" in raw) {
        post({ kind: "result", id: raw.id, ok: false, error: message });
      }
    }
  });

  post({ kind: "ready" });
}

void main();

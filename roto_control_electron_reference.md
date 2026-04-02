# Roto-Control ↔ Electron (JS) Integration Reference

This document is a practical, implementation-oriented reference for talking to **Melbourne Instruments Roto-Control** from a **JavaScript Electron app** (Windows primary, macOS supported), using **both**:

- **MIDI + SysEx (USB MIDI)** for “DAW-style” live UI publishing (labels, learn/mapping semantics, paging).
- **Serial API (USB COM port)** for deeper/persistent configuration (min/max ranges, per-control colour scheme, richer haptics, setup/plugin config editing).

It is written to support your desired behavior:
- Selecting an actor populates the inspector → Roto mirrors inspector properties in pages of 8 controls.
- Re-publish mapping on selection/state changes.
- Optional “favorites” global bank.
- Zoom mode that remaps encoders to digit editing.

---

## 0) What to build (recommended architecture)

### Processes
**Main process (Node)**
- Owns all hardware I/O:
  - MIDI in/out (including SysEx)
  - Serial port
- Exposes a clean IPC API to the renderer:
  - `connectRoto()`, `disconnectRoto()`
  - `publishBank(bankState)`
  - `setParamValue(paramId, value)`
  - `enterZoom(paramId)`, `exitZoom()`
  - `setPage(pageIndex)`, `setMode(mode)`
  - etc.

**Renderer process (UI)**
- Owns application state:
  - selected actor
  - inspector properties list
  - page index (per actor and/or global favorites)
  - “zoom mode” state
- Produces a stable **Parameter Schema** (see below) and sends it to main to publish.

---

## 1) Parameter Schema (input to the mapping compiler)

Represent every inspector property as:

```ts
type ParamType = "float" | "int" | "bool" | "enum";

type ParamSchema = {
  id: string;             // stable ID in your app
  name: string;           // human-friendly label (can be long)
  type: ParamType;

  // bounds: omit for "limitless" / unbounded parameters
  min?: number;
  max?: number;

  // stepping:
  step?: number;          // for float/int stepping
  enumLabels?: string[];  // for enum display strings

  // UI hints:
  favorite?: boolean;
  unit?: string;          // optional (used for formatting; Roto labels are short)
};
```

---

## 2) Core constraints from Roto APIs

### 2.1 SysEx message envelope (USB MIDI)
All Roto SysEx messages use this framing:

```
F0 00 22 03 02 <data> F7
```

- `00 22 03` = Melbourne Instruments SysEx ID
- `02` = Roto-Control v1 device ID

Within `<data>`, the first two bytes are typically:
- `Type` (e.g. `0A` GENERAL, `0B` PLUGIN)
- `Sub-type` / command (e.g. `01` DAW STARTED, `0A` LEARN PARAM)

### 2.2 Handshake (SysEx “DAW session”)
Roto expects a DAW-like handshake:

1) App sends **DAW STARTED**:
   `F0 00 22 03 02 0A 01 F7`
2) Roto will repeatedly send **PING DAW** once per second for up to a minute.
3) App responds **DAW PING RESPONSE** with DAW type:
   - `01` for Ableton
   - `02` for Bitwig

   `F0 00 22 03 02 0A 03 <DT> F7`

4) Roto sends **ROTO-DAW CONNECTED** when happy.

**Practical rule:** do not publish banks / send further SysEx until you’ve reached the connected state.

### 2.3 Name strings
Many SysEx/Serial structures use **0D-byte (13-byte) NULL-terminated ASCII strings**, padded with `00` if needed.

**Practical label budget:** treat as **12 visible ASCII chars** (keep a terminator), unless you’ve verified “exactly 13 printable” is accepted.

### 2.4 Serial transport
Serial API is a binary protocol over a USB serial (COM) port:

- **115200 baud, 8 data bits, no parity, 1 stop bit (8N1)**

Commands are request/response:
- Requests begin with a leading byte `5A`, then `Type`, then `Sub-type`, then payload.
- Responses begin with `A5`, then a response code (success = `00`), then remaining response payload.

Some commands require being inside a “config update session”:
- START CONFIG UPDATE (`5A 01 04 ...`)
- END CONFIG UPDATE (`5A 01 05 ...`)

---

## 3) Choosing SysEx vs Serial in your app

### Use SysEx for (live, per-selection UI)
- handshake + “DAW personality”
- paging semantics (track/plugin pages)
- “learn param” style publishing of controls
- renaming mapped controls

### Use Serial for (deeper control behavior & persistence)
- per-control min/max
- per-control colour scheme
- richer haptic modes (N-step, top indent, extra indents)
- editing stored plugin configs / MIDI setups
- setting current device mode (MIDI / PLUGIN / MIX) and page index

**Recommendation for your inspector-mirroring workflow:**
- Primary: SysEx for session + label/value publishing.
- Secondary: Serial for advanced per-control behavior (min/max & haptics) if you need them beyond the SysEx “learn param” model.

---

## 4) Libraries (Windows + macOS)

### MIDI + SysEx
Pick one:
- `@julusian/midi` (good maintained Node bindings; supports SysEx)
- `midi` (older; sometimes harder on Windows)

### Serial
- `serialport`

Example install:

```bash
npm i @julusian/midi serialport
```

---

## 5) MIDI device discovery (Node)

Typical approach:
1) enumerate MIDI inputs/outputs
2) match by port name containing `ROTO` / `Roto-Control`
3) open both input and output

Pseudo-code:

```ts
import { Input, Output } from "@julusian/midi";

function findPortIndexByName(port, needle: string) {
  const n = port.getPortCount();
  for (let i = 0; i < n; i++) {
    const name = port.getPortName(i);
    if (name.toLowerCase().includes(needle.toLowerCase())) return i;
  }
  return -1;
}
```

---

## 6) SysEx: encode/decode helpers

### 6.1 Two 7-bit bytes for a 14-bit value
Roto uses “two 7-bit values” for many numeric fields.

```ts
function u14To7bitPair(v: number): [number, number] {
  const clamped = Math.max(0, Math.min(16383, Math.round(v)));
  const msb = (clamped >> 7) & 0x7f;
  const lsb = clamped & 0x7f;
  return [msb, lsb];
}

function pair7bitToU14(msb: number, lsb: number): number {
  return ((msb & 0x7f) << 7) | (lsb & 0x7f);
}
```

### 6.2 0D-byte ASCII string (NULL-terminated, padded)
```ts
function toAscii0D(name: string): number[] {
  // strictly ASCII (0x20..0x7E recommended)
  const bytes = Array.from(name).map(ch => ch.charCodeAt(0) & 0x7f);
  const out = new Array(0x0D).fill(0);
  const maxChars = 0x0D - 1; // keep a null terminator
  for (let i = 0; i < Math.min(maxChars, bytes.length); i++) out[i] = bytes[i];
  out[Math.min(maxChars, bytes.length)] = 0x00; // explicit terminator
  return out;
}
```

---

## 7) Label shortening rule (your requested strategy)

> “Spread available characters evenly across up to the first 3 words.”

Implementation suggestion:
1) Split camelCase / snake_case / spaces into words.
2) Take up to 3 words.
3) Allocate ~12 chars across words (plus maybe 1–2 separators if you like).
4) Truncate each word to its allocation; remove vowels for long words if needed.

```ts
function splitWords(s: string): string[] {
  const spaced = s
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.split(/\s+/).filter(Boolean);
}

function shortenLabel(name: string, maxVisible = 12): string {
  const words = splitWords(name).slice(0, 3);
  if (words.length === 0) return "Param";

  // Reserve 0–2 chars for separators (use space)
  const sepCount = Math.max(0, words.length - 1);
  const budget = Math.max(1, maxVisible - sepCount);

  const base = Math.floor(budget / words.length);
  let extra = budget - base * words.length;

  const parts = words.map((w) => {
    const alloc = base + (extra-- > 0 ? 1 : 0);
    if (w.length <= alloc) return w;
    return w.slice(0, alloc);
  });

  return parts.join(" ");
}
```

---

## 8) SysEx “DAW host” flow for your inspector mapping

### 8.1 Treat your app as a “DAW in PLUGIN mode”
Conceptually:
- Actor ≈ plugin
- Inspector property ≈ plugin parameter
- Your current page of 8 properties ≈ current “plugin page” controls 0..7

In practice, you can use the **PLUGIN** command set and the **LEARN PARAM** mechanism to label/mode the 8 encoders.

### 8.2 Publishing a bank (8 params) using LEARN PARAM

LEARN PARAM payload:

```
0B 0A <PI:2 PH:6 MP CI NS PP:2 PN:0D SN:NS*0D>
```

Key fields:
- `PI` = parameter index (two 7-bit values)
- `PH` = 6-byte parameter hash
- `MP` = macro param (00/01) (use 00)
- `CI` = add centre (top) indent (00/01)
- `NS` = number of steps: 00 or 02..18
- `PP` = param position 0..16383 (two 7-bit values)
- `PN` = 0D ASCII name
- `SN` = optional labels for quantized steps (only if NS <= 10)

**Important:** if `CI=01`, `NS` is ignored.

#### Practical mapping policy for your inspector:
- bool:
  - treat as 2 steps (NS=02), and set SN=["Off","On"] (or your own strings)
- enum:
  - if <= 10 values: NS = len(labels), SN = labels
  - if > 10: consider “endless” + use your own value formatting (since SN won’t be sent)
- stepped numeric:
  - choose NS based on your step / range (clamp to 18 if you want detented feel)
- smooth numeric:
  - NS=00, CI=00 (no detents)
- “centered” params (e.g. pan, signed):
  - CI=01 (top indent) to give a tactile center

#### Hash field (PH)
The API expects a 6-byte hash. For your app, generate a stable 6-byte value per param:
- e.g. SHA1(paramId) and take first 6 bytes.
- Ensure each byte is 7-bit safe if needed; if strict, mask with `0x7F`.

---

## 9) Serial: per-control config (min/max, colour, haptics)

When you need min/max and richer haptic control, use the Serial PLUGIN config commands.

Example: **SET PLUGIN KNOB CONFIG**:

```
5A 03 0B <CL:2 PH:8 CI MI:2 MH:6 MA MN:2 MX:2 CN:0D CS HM IP1 IP2 HS SN:HS*0D>
```

Key fields you’ll care about:
- `MN` / `MX` min/max
- `CN` 0D name
- `CS` colour scheme index
- `HM` haptic mode: KNOB_300 / KNOB_N_STEP / KNOB_300_TOP_INDENT
- `HS` number of steps for N_STEP (02..10)
- `SN` step labels

**Requires** a config update session:
- START CONFIG UPDATE
- (do your SET_* commands)
- END CONFIG UPDATE

---

## 10) “Set knob position” (motor position)

Your safest general approach:
- treat knob position as the **parameter value** in 14-bit space and keep Roto updated whenever the underlying value changes (from your app, or as a result of other UI operations).

In SysEx LEARN PARAM you provide `PP` (0..16383) which expresses the current position/value in the Roto ecosystem.

For continuous operation, you’ll typically:
- update values via regular MIDI (CC / 14-bit CC) OR by re-sending appropriate SysEx updates when needed, depending on how you structure your mapping.

(Exact per-control CC numbers depend on how the current mode/setup is configured; if you drive everything through “plugin mode learn mapping” you can avoid hard-coding CCs by staying within that paradigm.)

---

## 11) Paging & state ownership

### App-owned state (recommended)
Keep page state entirely in your Electron app:
- `pageIndex` for the selected actor
- `favoritesPageIndex` for global favorites
- `zoomMode` on/off + target param

When the user pages (via Roto buttons or your UI), you:
1) update `pageIndex`
2) re-publish the 8-slot mapping (SysEx + optional Serial)

### Device mode + page index (Serial)
Serial GET/SET MODE include a `PI` field:
- page index in multiples of 8 (`00` = page 1, `08` = page 2, etc.)

You can set the device mode and page index if you want the hardware itself to show a consistent “page number” while your app remains authoritative.

---

## 12) Zoom Mode (“digit editing”) implementation guide

Goal:
- Press button under knob → enter zoom mode for that param.
- Map encoders to digits, plus one “decimal scroll” encoder.
- Carry/borrow across digits.

Recommended strategy:
1) Freeze current bank mapping.
2) Build a **digit window** representation:
   - sign (handled in app)
   - digits array (coarse..fine)
   - decimal index
3) Publish a special “zoom bank” of 8 controls:
   - labels like `D5 D4 D3 D2 D1 d1 d2 DEC` (or your preference)
4) Interpret encoder deltas as:
   - detented: ±1 step per tick
   - non-detented: micro deltas route to finer digits (your rule)

Decimal scroll:
- While user is moving the DEC encoder, shift decimal index left/right.
- When movement stops (debounce), reassign the DEC encoder to a digit role (optional) and republish labels.

Because labels are short, keep them compact; you can still show the full numeric value in your inspector UI.

---

## 13) Minimal “session skeleton” (pseudo-code)

```ts
class RotoHost {
  midiIn: Input;
  midiOut: Output;
  serial: SerialPort;

  state = {
    sysexConnected: false,
    serialConnected: false,
  };

  async connect() {
    // 1) open MIDI ports
    // 2) open serial port (optional)
    // 3) send DAW STARTED
    // 4) wait for PING DAW and respond with DAW PING RESPONSE
    // 5) wait for ROTO-DAW CONNECTED
  }

  publishBank(params: ParamSchema[], pageIndex: number) {
    // choose slice of 8
    // for each slot:
    //  - build LEARN PARAM message
    //  - send SysEx
    // optionally:
    //  - enter serial config update session and SET PLUGIN KNOB CONFIG for per-control min/max/haptics
  }
}
```

---

## 14) Practical notes (Windows + macOS)

- On Windows, you may see multiple MIDI ports for the same device (e.g., “ROTO CONTROL”, “ROTO CONTROL DAW”, etc.). Decide which one actually carries SysEx by sending DAW STARTED and waiting for PING DAW.
- Serial ports may appear/disappear when switching device modes. Implement reconnect logic:
  - rescan ports every couple seconds if disconnected
  - expose a “Reconnect Roto” button in your debug UI

---

## 15) Checklist for your desired “inspector personality”

- [ ] Stable ParamSchema for inspector props (type, bounds, step, enum labels)
- [ ] Bank compiler: schema → 8-slot page with:
  - label shortening
  - per-type haptic/step strategy
  - 14-bit value normalization
- [ ] SysEx session manager (handshake + message send/receive)
- [ ] Serial session manager (open COM, request fw/mode, config update sessions)
- [ ] Paging + favorites routing
- [ ] Zoom mode remap (digit editing)

---

## Appendix: “Known-good bytes” (quick reference)

### SysEx envelope
- Start: `F0`
- Manufacturer: `00 22 03`
- Device ID: `02`
- End: `F7`

### SysEx handshake
- DAW STARTED: `0A 01`
- PING DAW: `0A 02` (from Roto)
- DAW PING RESPONSE: `0A 03 <DT>`
- ROTO-DAW CONNECTED: `0A 0C` (from Roto)

### Serial basics
- Request prefix: `5A`
- Response prefix: `A5`
- Port: `115200 8N1`
- Config session:
  - START CONFIG UPDATE: `5A 01 04`
  - END CONFIG UPDATE: `5A 01 05`

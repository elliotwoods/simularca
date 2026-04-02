import { createHash } from "node:crypto";
import type {
  RotoControlBank,
  RotoControlDawEmulation,
  RotoControlInputEvent,
  RotoControlSerialCandidate,
  RotoControlSlot,
  RotoControlState
} from "../src/types/ipc";

const MIDI_NAME_NEEDLE = "roto";
const SERIAL_BAUD_RATE = 115200;
const SERIAL_VENDOR_ID = "2E8A";
const SERIAL_PRODUCT_ID = "F010";
const ROTO_RUNTIME_PLUGIN_HASH_SOURCE = "SimularcaRuntimePlugin";
const SYSEX_PREFIX = [0xf0, 0x00, 0x22, 0x03, 0x02];
const SYSEX_SUFFIX = 0xf7;
const RECONNECT_INTERVAL_MS = 2000;
const GENERAL_TYPE = 0x0a;
const GENERAL_DAW_STARTED = 0x01;
const GENERAL_PING_DAW = 0x02;
const GENERAL_PING_RESPONSE = 0x03;
const GENERAL_NUM_TRACKS = 0x04;
const GENERAL_FIRST_TRACK = 0x05;
const GENERAL_TRACK_DETAILS = 0x07;
const GENERAL_TRACK_DETAILS_END = 0x08;
const GENERAL_CONNECTED_ACK = 0x0d;
const GENERAL_CONNECTED = 0x0c;
const PLUGIN_TYPE = 0x0b;
const PLUGIN_SET_MODE = 0x01;
const PLUGIN_NUM_DEVICES = 0x02;
const PLUGIN_FIRST_DEVICE = 0x03;
const PLUGIN_DEVICE_DETAILS = 0x05;
const PLUGIN_DEVICE_DETAILS_END = 0x06;
const PLUGIN_DAW_SELECT_PLUGIN = 0x08;
const PLUGIN_LEARN_PARAM = 0x0a;
const PLUGIN_CONTROL_MAPPED = 0x0b;
const EMPTY_SLOT_LABEL = " ";
const PLUGIN_ENCODER_MSB_BASE = 12;
const PLUGIN_ENCODER_LSB_BASE = 44;
const PLUGIN_BUTTON_CC_BASE = 20;
const PLUGIN_TRANSPORT_CC_BASE = 28;
const SERIAL_MESSAGE_COMMAND = 0x5a;
const SERIAL_MESSAGE_RESPONSE = 0xa5;
const SERIAL_RESPONSE_OK = 0x00;
const SERIAL_RESPONSE_UNCONFIGURED = 0xfd;
const SERIAL_RESPONSE_BUSY = 0xfb;
const SERIAL_RESPONSE_CONFLICT = 0xfc;
const SERIAL_GENERAL = 0x01;
const SERIAL_GENERAL_START_CONFIG_UPDATE = 0x04;
const SERIAL_GENERAL_END_CONFIG_UPDATE = 0x05;
const SERIAL_PLUGIN = 0x03;
const SERIAL_PLUGIN_GET_PLUGIN = 0x04;
const SERIAL_PLUGIN_ADD_PLUGIN = 0x06;
const SERIAL_PLUGIN_SET_PLUGIN_NAME = 0x07;
const SERIAL_PLUGIN_SET_KNOB_CONFIG = 0x0b;
const SERIAL_PLUGIN_SET_SWITCH_CONFIG = 0x0c;
const INPUT_SUPPRESSION_LOGGING = false;
const VERBOSE_TRANSPORT_LOGGING = false;
const BANK_INPUT_SUPPRESSION_MS = 150;
const SERIAL_PROVISION_DEBOUNCE_MS = 180;
const SERIAL_RETRY_COOLDOWN_MS = 1500;
type NavigationInputType = "page-prev" | "page-next" | "navigate-back" | "navigate-forward";

const NAV_CC_MAP = new Map<number, NavigationInputType>([
  [PLUGIN_TRANSPORT_CC_BASE + 5, "page-prev"],
  [PLUGIN_TRANSPORT_CC_BASE + 6, "page-next"],
  [PLUGIN_TRANSPORT_CC_BASE + 3, "navigate-back"],
  [PLUGIN_TRANSPORT_CC_BASE + 4, "navigate-forward"]
]);
const MIDI_BINDINGS_UNAVAILABLE_MESSAGE = "MIDI bindings unavailable.";
const MIDI_PORTS_NOT_FOUND_MESSAGE = "Roto-Control MIDI ports not found.";
const SERIAL_BINDINGS_UNAVAILABLE_MESSAGE = "Serial bindings unavailable. Serial configuration features are disabled.";
const NO_SERIAL_PORTS_MESSAGE = "No compatible Roto serial ports detected.";

type MidiInputHandle = {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  closePort(): void;
  ignoreTypes(sysex: boolean, timing: boolean, sensing: boolean): void;
  on(event: "message", listener: (deltaTime: number, message: number[]) => void): void;
  removeAllListeners?(event?: string): void;
};

type MidiOutputHandle = {
  getPortCount(): number;
  getPortName(index: number): string;
  openPort(index: number): void;
  closePort(): void;
  sendMessage(message: number[]): void;
};

type SerialPortHandle = {
  write(data: Uint8Array | number[] | Buffer, callback?: (error: Error | null | undefined) => void): void;
  close(callback?: (error?: Error | null) => void): void;
  on(event: "data", listener: (data: Buffer | Uint8Array | number[]) => void): void;
  on(event: "open", listener: () => void): void;
  on(event: "error" | "close", listener: (error?: Error) => void): void;
};

type MidiBindings = {
  input: new () => MidiInputHandle;
  output: new () => MidiOutputHandle;
};

interface SerialPortEntry {
  path: string;
  friendlyName?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
}

type SerialBindings = {
  SerialPort: new (options: { path: string; baudRate: number; autoOpen?: boolean }) => SerialPortHandle;
  list(): Promise<SerialPortEntry[]>;
};

interface SelectedSerialPort {
  entry: SerialPortEntry;
  reason: string;
}

interface SerialSelectionResult {
  candidates: RotoControlSerialCandidate[];
  selected: SelectedSerialPort | null;
  reason: string;
}

interface RuntimePluginSlotConfig {
  slot: RotoControlSlot;
  localControlIndex: number;
  absoluteControlIndex: number;
}

interface RuntimePluginConfig {
  hash: number[];
  name: string;
  pageCount: number;
  pageIndex: number;
  slots: RuntimePluginSlotConfig[];
}

interface SerialPluginSwitchConfig {
  controlIndex: number;
  mappedParam: number;
  paramHash: number[];
  minValue: number;
  maxValue: number;
  controlName: string;
  colorScheme: number;
  ledOnColor: number;
  ledOffColor: number;
  hapticMode: number;
  hapticSteps: number;
  stepNames: string[];
}

interface SerialRequestResult {
  responseCode: number;
  payload: Buffer;
}

class SerialAdminRequestError extends Error {
  public readonly responseCode: number;
  public readonly requestType: string;

  public constructor(requestType: string, responseCode: number) {
    super(`Serial admin request failed with response code 0x${responseCode.toString(16).padStart(2, "0")}.`);
    this.name = "SerialAdminRequestError";
    this.requestType = requestType;
    this.responseCode = responseCode;
  }
}

export interface RotoControlHostOptions {
  emitState: (state: RotoControlState) => void;
  emitInput: (event: RotoControlInputEvent) => void;
  log: (message: string, metadata?: unknown) => void;
}

interface RotoControlHostDependencies {
  loadMidiBindings?: () => Promise<MidiBindings | null>;
  loadSerialBindings?: () => Promise<SerialBindings | null>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

function u14To7BitPair(value: number): [number, number] {
  const clamped = Math.max(0, Math.min(16383, Math.round(value)));
  return [((clamped >> 7) & 0x7f) >>> 0, (clamped & 0x7f) >>> 0];
}

function shortenRotoTransportLabel(label: string, maxVisible = 12): string {
  const ascii = label.replace(/[^\x20-\x7E]/g, "");
  const words = ascii
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length === 0) {
    return "";
  }
  const separators = Math.max(0, words.length - 1);
  const visibleBudget = Math.max(1, maxVisible - separators);
  const baseBudget = Math.floor(visibleBudget / words.length);
  let remainder = visibleBudget - baseBudget * words.length;
  const parts = words.map((word) => {
    const allocation = baseBudget + (remainder-- > 0 ? 1 : 0);
    return word.length <= allocation ? word : word.slice(0, allocation);
  });
  return parts.join(" ").slice(0, maxVisible);
}

function toAscii0D(label: string): number[] {
  const ascii = shortenRotoTransportLabel(label, 12).replace(/[^\x20-\x7E]/g, "");
  const result = new Array<number>(13).fill(0);
  const visible = ascii.slice(0, 12);
  for (let index = 0; index < visible.length; index += 1) {
    result[index] = visible.charCodeAt(index) & 0x7f;
  }
  return result;
}

function stableHash6(input: string): number[] {
  return [...createHash("sha1").update(input).digest().subarray(0, 6)].map((byte) => byte & 0x7f);
}

function stableHash8(input: string): number[] {
  return [...createHash("sha1").update(input).digest().subarray(0, 8)].map((byte) => byte & 0x7f);
}

function normalizedToU14(normalized?: number): number {
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(1, normalized)) * 16383);
}

function getBankSlots(bank: RotoControlBank): RotoControlSlot[] {
  return Array.isArray(bank.allSlots) && bank.allSlots.length > 0 ? bank.allSlots : bank.slots;
}

function runtimePluginHashSource(bank: RotoControlBank): string {
  const slots = getBankSlots(bank);
  const slotSignature = slots
    .map((slot, index) => `${index}:${slot.id}:${slot.label}:${slot.kind}:${slot.disabled ? 1 : 0}`)
    .join("|");
  return `${ROTO_RUNTIME_PLUGIN_HASH_SOURCE}:${bank.contextPath}:${bank.pageCount}:${slotSignature}`;
}

function provisionSignatureForBank(bank: RotoControlBank): string {
  const slots = getBankSlots(bank);
  const signatureInput = [
    bank.title,
    bank.contextPath,
    String(bank.pageCount),
    ...slots.map((slot, index) =>
      [
        index,
        slot.id,
        slot.label,
        slot.kind,
        slot.colorRole,
        slot.disabled ? 1 : 0,
        slot.quantizedStepCount ?? "",
        slot.centered ? 1 : 0,
        slot.stepLabels?.join(",") ?? "",
        slot.enumLabels?.join(",") ?? ""
      ].join(":")
    )
  ].join("|");
  return createHash("sha1").update(signatureInput).digest("hex").slice(0, 12);
}

function isTemporarySerialAdminResponse(responseCode: number): boolean {
  return responseCode === SERIAL_RESPONSE_BUSY || responseCode === SERIAL_RESPONSE_CONFLICT;
}

function rotoColorScheme(role: RotoControlSlot["colorRole"]): number {
  switch (role) {
    case "translate":
      return 1;
    case "rotate":
      return 2;
    case "scale":
      return 3;
    case "enum":
      return 4;
    case "toggle":
      return 5;
    case "drill":
      return 6;
    case "action":
      return 7;
    case "zoom":
      return 8;
    default:
      return 0;
  }
}

function rotoLedOnColor(role: RotoControlSlot["colorRole"]): number {
  switch (role) {
    case "translate":
      return 6;
    case "rotate":
      return 9;
    case "scale":
      return 3;
    case "enum":
      return 5;
    case "toggle":
      return 2;
    case "drill":
      return 11;
    case "action":
      return 12;
    case "zoom":
      return 8;
    default:
      return 10;
  }
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(127, Math.round(value)));
}

function buildSysex(data: number[]): number[] {
  return [...SYSEX_PREFIX, ...data.map((byte) => byte & 0x7f), SYSEX_SUFFIX];
}

function normalizeUsbId(value?: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/^0x/i, "").trim().toUpperCase();
  return normalized || null;
}

function extractInterfaceNumber(pnpId?: string): number | null {
  if (typeof pnpId !== "string") {
    return null;
  }
  const match = /MI_(\d+)/i.exec(pnpId);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function extractComPortNumber(path: string): number | null {
  const match = /COM(\d+)/i.exec(path);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function isCompatibleRotoSerialPort(entry: SerialPortEntry): boolean {
  const vendorId = normalizeUsbId(entry.vendorId);
  const productId = normalizeUsbId(entry.productId);
  if (vendorId === SERIAL_VENDOR_ID && productId === SERIAL_PRODUCT_ID) {
    return true;
  }
  const haystack = `${entry.path} ${entry.friendlyName ?? ""} ${entry.manufacturer ?? ""}`.toLowerCase();
  return haystack.includes(MIDI_NAME_NEEDLE);
}

export function scoreMatchingPortName(name: string): number {
  const lowered = name.toLowerCase();
  if (!lowered.includes(MIDI_NAME_NEEDLE)) {
    return -1;
  }
  let score = 1;
  if (lowered.includes("daw")) {
    score += 8;
  }
  if (lowered.includes("control")) {
    score += 4;
  }
  if (lowered.includes("plugin")) {
    score += 2;
  }
  return score;
}

function findMatchingPort(port: { getPortCount(): number; getPortName(index: number): string }): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < port.getPortCount(); index += 1) {
    const name = port.getPortName(index);
    const score = scoreMatchingPortName(name);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function scoreSerialCandidate(entry: Pick<SerialPortEntry, "path" | "friendlyName" | "manufacturer" | "vendorId" | "productId" | "pnpId">): number {
  let score = 0;
  const vendorId = normalizeUsbId(entry.vendorId);
  const productId = normalizeUsbId(entry.productId);
  if (vendorId === SERIAL_VENDOR_ID) {
    score += 1000;
  }
  if (productId === SERIAL_PRODUCT_ID) {
    score += 1000;
  }
  const haystack = `${entry.path} ${entry.friendlyName ?? ""} ${entry.manufacturer ?? ""}`.toLowerCase();
  if (haystack.includes(MIDI_NAME_NEEDLE)) {
    score += 200;
  }
  if (haystack.includes("usb serial")) {
    score += 25;
  }
  const interfaceNumber = extractInterfaceNumber(entry.pnpId);
  if (interfaceNumber !== null) {
    score += Math.max(0, 50 - interfaceNumber);
  }
  const comPortNumber = extractComPortNumber(entry.path);
  if (comPortNumber !== null) {
    score += Math.max(0, 20 - Math.min(comPortNumber, 20));
  }
  return score;
}

export function selectSerialPort(entries: SerialPortEntry[], overridePath: string | null): SerialSelectionResult {
  const matchingEntries = entries.filter((entry) => isCompatibleRotoSerialPort(entry) || entry.path === overridePath);
  const rankedEntries = matchingEntries
    .map((entry) => ({
      entry,
      score: scoreSerialCandidate(entry)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entry.path.localeCompare(right.entry.path);
    });
  const autoSelected = rankedEntries[0]?.entry ?? null;
  const manualSelection = overridePath ? rankedEntries.find((candidate) => candidate.entry.path === overridePath)?.entry ?? null : null;
  let selected: SelectedSerialPort | null = null;
  let reason = NO_SERIAL_PORTS_MESSAGE;
  if (manualSelection) {
    selected = {
      entry: manualSelection,
      reason: `Using manual serial override ${manualSelection.path}.`
    };
    reason = selected.reason;
  } else if (overridePath && autoSelected) {
    selected = {
      entry: autoSelected,
      reason: `Manual serial override ${overridePath} is unavailable. Auto-selected ${autoSelected.path} from ${rankedEntries.length} matching serial ports.`
    };
    reason = selected.reason;
  } else if (overridePath) {
    reason = `Manual serial override ${overridePath} is unavailable and no compatible serial ports were detected.`;
  } else if (autoSelected) {
    selected = {
      entry: autoSelected,
      reason:
        rankedEntries.length === 1
          ? `Auto-selected ${autoSelected.path}.`
          : `Auto-selected ${autoSelected.path} from ${rankedEntries.length} matching Roto serial ports.`
    };
    reason = selected.reason;
  }
  const candidates = rankedEntries.map(({ entry }) => ({
    path: entry.path,
    friendlyName: entry.friendlyName ?? null,
    vendorId: normalizeUsbId(entry.vendorId),
    productId: normalizeUsbId(entry.productId),
    selected: selected?.entry.path === entry.path
  }));
  return {
    candidates,
    selected,
    reason
  };
}

function slotIndexFromAbsoluteController(controller: number, base: number): number | null {
  if (controller < base || controller >= base + 8) {
    return null;
  }
  return controller - base;
}

function isTransientMidiError(message: string | null | undefined): boolean {
  return message === MIDI_BINDINGS_UNAVAILABLE_MESSAGE || message === MIDI_PORTS_NOT_FOUND_MESSAGE;
}

function createDefaultState(overridePath: string | null = null): RotoControlState {
  return {
    available: false,
    midiConnected: false,
    serialConnected: false,
    sysexConnected: false,
    lastError: null,
    inputMode: "plugin",
    connectionPhase: "disconnected",
    requiredDeviceMode: "plugin",
    statusSummary: "Roto-Control is not connected.",
    setupInstructions: [
      "Connect Roto-Control over USB.",
      "Switch the controller to PLUGIN mode.",
      "Wait for the DAW handshake to complete."
    ],
    midiInputPortName: null,
    midiOutputPortName: null,
    serialPortPath: null,
    serialDiscoveryMode: overridePath ? "manual" : "auto",
    serialPortOverridePath: overridePath,
    serialSelectionReason: NO_SERIAL_PORTS_MESSAGE,
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
}

export function buildLearnParamMessage(slot: RotoControlSlot, absoluteSlotIndex: number): number[] {
  return buildSysex(buildLearnParamBody(slot, absoluteSlotIndex));
}

function buildLearnParamBody(slot: RotoControlSlot, absoluteSlotIndex: number): number[] {
  const parameterIndex = u14To7BitPair(absoluteSlotIndex);
  const macroParam = 0x00;
  const centered = slot.centered ? 0x01 : 0x00;
  const quantizedSteps =
    typeof slot.quantizedStepCount === "number" && slot.quantizedStepCount >= 2
      ? Math.max(2, Math.min(18, Math.floor(slot.quantizedStepCount)))
      : 0;
  const stepLabels =
    quantizedSteps > 0 && quantizedSteps <= 10 && Array.isArray(slot.stepLabels)
      ? slot.stepLabels.slice(0, quantizedSteps)
      : undefined;
  const numberOfSteps = centered ? 0x00 : quantizedSteps & 0x7f;
  return [
    PLUGIN_TYPE,
    PLUGIN_LEARN_PARAM,
    ...parameterIndex,
    ...stableHash6(slot.id),
    macroParam,
    centered,
    numberOfSteps,
    ...u14To7BitPair(normalizedToU14(slot.normalizedValue)),
    ...toAscii0D(slot.label || EMPTY_SLOT_LABEL),
    ...(stepLabels ?? []).flatMap((label) => toAscii0D(label))
  ];
}

function buildRuntimePluginConfig(bank: RotoControlBank): RuntimePluginConfig {
  const allSlots = getBankSlots(bank);
  return {
    hash: stableHash8(runtimePluginHashSource(bank)),
    name: bank.title,
    pageCount: bank.pageCount,
    pageIndex: bank.pageIndex,
    slots: allSlots.map((slot, absoluteControlIndex) => ({
      slot,
      localControlIndex: absoluteControlIndex % 8,
      absoluteControlIndex
    }))
  };
}

function buildNumTracksBody(trackCount: number): number[] {
  const [msb, lsb] = u14To7BitPair(trackCount);
  return [GENERAL_TYPE, GENERAL_NUM_TRACKS, msb, lsb];
}

function buildFirstTrackBody(trackIndex: number): number[] {
  const [msb, lsb] = u14To7BitPair(trackIndex);
  return [GENERAL_TYPE, GENERAL_FIRST_TRACK, msb, lsb];
}

function buildTrackDetailsBody(trackIndex: number, trackName: string, colorIndex = 0, isFoldable = false): number[] {
  const [msb, lsb] = u14To7BitPair(trackIndex);
  return [GENERAL_TYPE, GENERAL_TRACK_DETAILS, msb, lsb, ...toAscii0D(trackName), colorIndex & 0x7f, isFoldable ? 0x01 : 0x00];
}

function buildPluginDetailsBody(plugin: RuntimePluginConfig): number[] {
  return [
    PLUGIN_TYPE,
    PLUGIN_DEVICE_DETAILS,
    0x00,
    ...plugin.hash,
    0x01,
    ...toAscii0D(plugin.name),
    0x02,
    plugin.pageCount & 0x7f
  ];
}

function buildPluginSelectionBody(pluginIndex: number, pageIndex = 0, forcePlugin = false): number[] {
  return [PLUGIN_TYPE, PLUGIN_DAW_SELECT_PLUGIN, pluginIndex & 0x7f, pageIndex & 0x7f, forcePlugin ? 0x01 : 0x00];
}

function makeSerialRequest(command: number, subCommand: number, payload: number[] = []): Buffer {
  const length = payload.length;
  return Buffer.from([SERIAL_MESSAGE_COMMAND, command & 0xff, subCommand & 0xff, (length >> 8) & 0xff, length & 0xff, ...payload]);
}

function buildSerialStartConfigUpdateRequest(): Buffer {
  return makeSerialRequest(SERIAL_GENERAL, SERIAL_GENERAL_START_CONFIG_UPDATE);
}

function buildSerialEndConfigUpdateRequest(): Buffer {
  return makeSerialRequest(SERIAL_GENERAL, SERIAL_GENERAL_END_CONFIG_UPDATE);
}

function buildSerialPluginGetRequest(plugin: RuntimePluginConfig): Buffer {
  return makeSerialRequest(SERIAL_PLUGIN, SERIAL_PLUGIN_GET_PLUGIN, plugin.hash);
}

function buildSerialPluginAddRequest(plugin: RuntimePluginConfig): Buffer {
  return makeSerialRequest(SERIAL_PLUGIN, SERIAL_PLUGIN_ADD_PLUGIN, [...plugin.hash, ...toAscii0D(plugin.name)]);
}

function buildSerialPluginSetNameRequest(plugin: RuntimePluginConfig): Buffer {
  return makeSerialRequest(SERIAL_PLUGIN, SERIAL_PLUGIN_SET_PLUGIN_NAME, [...plugin.hash, ...toAscii0D(plugin.name)]);
}

function buildSerialPluginSetKnobConfigRequest(plugin: RuntimePluginConfig, config: RuntimePluginSlotConfig): Buffer {
  const quantizedSteps =
    typeof config.slot.quantizedStepCount === "number" && config.slot.quantizedStepCount > 0
      ? Math.min(16, Math.floor(config.slot.quantizedStepCount))
      : 0;
  const stepLabels =
    quantizedSteps > 0 && Array.isArray(config.slot.stepLabels) ? config.slot.stepLabels.slice(0, quantizedSteps) : [];
  const isQuantized = quantizedSteps >= 2;
  const payload = [
    ...plugin.hash,
    config.absoluteControlIndex & 0xff,
    (config.absoluteControlIndex >> 8) & 0xff,
    config.absoluteControlIndex & 0xff,
    ...stableHash6(config.slot.id),
    0x00,
    0x00,
    0x00,
    0x3f,
    0xff,
    ...toAscii0D(config.slot.label || EMPTY_SLOT_LABEL),
    rotoColorScheme(config.slot.colorRole),
    isQuantized ? 0x01 : 0x00,
    config.slot.centered ? 0x40 : 0xff,
    0xff,
    quantizedSteps & 0xff
  ];
  for (let index = 0; index < 16; index += 1) {
    payload.push(...toAscii0D(stepLabels[index] ?? ""));
  }
  return makeSerialRequest(SERIAL_PLUGIN, SERIAL_PLUGIN_SET_KNOB_CONFIG, payload);
}

function buildSerialPluginSetSwitchConfigRequest(plugin: RuntimePluginConfig, config: SerialPluginSwitchConfig): Buffer {
  const payload = [
    ...plugin.hash,
    config.controlIndex & 0xff,
    (config.mappedParam >> 8) & 0xff,
    config.mappedParam & 0xff,
    ...config.paramHash.slice(0, 6).map((value) => value & 0x7f),
    config.minValue & 0xff,
    config.maxValue & 0xff,
    ...toAscii0D(config.controlName),
    config.colorScheme & 0xff,
    config.ledOnColor & 0xff,
    config.ledOffColor & 0xff,
    config.hapticMode & 0xff,
    config.hapticSteps & 0xff
  ];
  for (let index = 0; index < config.hapticSteps; index += 1) {
    payload.push(...toAscii0D(config.stepNames[index] ?? ""));
  }
  return makeSerialRequest(SERIAL_PLUGIN, SERIAL_PLUGIN_SET_SWITCH_CONFIG, payload);
}

function buildSerialPluginSwitchConfig(config: RuntimePluginSlotConfig): SerialPluginSwitchConfig {
  const stepLabels = Array.isArray(config.slot.stepLabels) ? config.slot.stepLabels.slice(0, 10) : [];
  const hapticSteps =
    config.slot.kind === "bool"
      ? 2
      : typeof config.slot.quantizedStepCount === "number" && config.slot.quantizedStepCount >= 2
        ? Math.min(10, config.slot.quantizedStepCount)
        : 0;
  const isToggle = config.slot.kind === "bool" || config.slot.kind === "enum";
  const colorScheme = rotoColorScheme(config.slot.colorRole);
  return {
    controlIndex: config.absoluteControlIndex,
    mappedParam: config.absoluteControlIndex,
    paramHash: stableHash6(config.slot.id),
    minValue: 0,
    maxValue: Math.max(1, hapticSteps > 0 ? hapticSteps - 1 : 1),
    controlName: config.slot.label || EMPTY_SLOT_LABEL,
    colorScheme,
    ledOnColor: rotoLedOnColor(config.slot.colorRole),
    ledOffColor: 0,
    hapticMode: isToggle ? 0x01 : 0x00,
    hapticSteps,
    stepNames: hapticSteps > 0 ? stepLabels.slice(0, hapticSteps) : []
  };
}

async function loadMidiBindings(): Promise<MidiBindings | null> {
  try {
    const moduleValue = await import("@julusian/midi");
    const input = (moduleValue as { Input?: new () => MidiInputHandle }).Input;
    const output = (moduleValue as { Output?: new () => MidiOutputHandle }).Output;
    if (!input || !output) {
      return null;
    }
    return { input, output };
  } catch {
    return null;
  }
}

async function loadSerialBindings(): Promise<SerialBindings | null> {
  try {
    const moduleValue = await import("serialport");
    const SerialPort =
      (moduleValue as { SerialPort?: new (options: { path: string; baudRate: number; autoOpen?: boolean }) => SerialPortHandle })
        .SerialPort;
    const listMethod = (SerialPort as unknown as { list?: () => Promise<SerialPortEntry[]> }).list;
    if (!SerialPort || typeof listMethod !== "function") {
      return null;
    }
    const list = async () => (await listMethod()) ?? [];
    return { SerialPort, list };
  } catch {
    return null;
  }
}

export class RotoControlHost {
  private readonly options: RotoControlHostOptions;
  private readonly deps: Required<RotoControlHostDependencies>;
  private state: RotoControlState;
  private midiInput: MidiInputHandle | null = null;
  private midiOutput: MidiOutputHandle | null = null;
  private serialPort: SerialPortHandle | null = null;
  private currentBank: RotoControlBank | null = null;
  private currentBankRevision = 0;
  private suppressInputUntil = 0;
  private lastEncoder14BitValues = new Map<number, number>();
  private connectPromise: Promise<RotoControlState> | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private connectRequested = false;
  private serialPortOverridePath: string | null = null;
  private dawEmulation: RotoControlDawEmulation = "ableton";
  private serialBuffer = Buffer.alloc(0);
  private serialRequestChain: Promise<void> = Promise.resolve();
  private serialProvisionTimer: ReturnType<typeof setTimeout> | null = null;
  private serialProvisionPromise: Promise<void> | null = null;
  private serialProvisionScheduledSignature: string | null = null;
  private lastProvisionedSignature: string | null = null;
  private lastProvisionFailedSignature: string | null = null;
  private serialCooldownUntil = 0;
  private pendingSerialResponse:
    | {
        expectedBytes: number;
        resolve: (result: SerialRequestResult) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | null = null;

  public constructor(options: RotoControlHostOptions, deps: RotoControlHostDependencies = {}) {
    this.options = options;
    this.deps = {
      loadMidiBindings: deps.loadMidiBindings ?? loadMidiBindings,
      loadSerialBindings: deps.loadSerialBindings ?? loadSerialBindings,
      setInterval: deps.setInterval ?? globalThis.setInterval,
      clearInterval: deps.clearInterval ?? globalThis.clearInterval,
      setTimeout: deps.setTimeout ?? globalThis.setTimeout,
      clearTimeout: deps.clearTimeout ?? globalThis.clearTimeout
    };
    this.state = createDefaultState();
  }

  public getState(): RotoControlState {
    return this.state;
  }

  public async connect(): Promise<RotoControlState> {
    this.connectRequested = true;
    this.disposed = false;
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    this.connectPromise = this.connectInternal();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public async refresh(): Promise<RotoControlState> {
    this.connectRequested = true;
    this.disposed = false;
    this.disposeConnections();
    const state = await this.connect();
    this.publishCurrentBankToDevice();
    return state;
  }

  public async setSerialPortOverride(path: string | null): Promise<RotoControlState> {
    const normalizedPath = path?.trim() ? path.trim() : null;
    const overrideChanged = normalizedPath !== this.serialPortOverridePath;
    this.serialPortOverridePath = normalizedPath;
    this.connectRequested = true;
    this.disposed = false;
    if (overrideChanged && this.serialPort) {
      this.disposeSerialConnection();
      this.updateState({
        serialConnected: false,
        serialPortPath: null,
        serialAdminState: "idle",
        lastSerialResponseCode: null,
        lastSerialRequestType: null,
        usingCachedProvisionedDefinition: false
      });
    } else {
      this.updateState({});
    }
    const state = await this.connect();
    this.publishCurrentBankToDevice();
    return state;
  }

  public async setDawEmulation(mode: RotoControlDawEmulation): Promise<RotoControlState> {
    const nextMode: RotoControlDawEmulation = mode === "bitwig" ? "bitwig" : "ableton";
    const changed = nextMode !== this.dawEmulation;
    this.dawEmulation = nextMode;
    this.updateState({});
    if (!changed) {
      return this.state;
    }
    this.options.log("Changed Roto DAW emulation", { dawEmulation: this.dawEmulation });
    return await this.refresh();
  }

  public dispose(): void {
    this.disposed = true;
    this.connectRequested = false;
    this.stopReconnectLoop();
    this.disposeConnections();
  }

  public async publishBank(bank: RotoControlBank): Promise<void> {
    const bankIdentityChanged =
      this.currentBank?.contextPath !== bank.contextPath || this.currentBank?.pageIndex !== bank.pageIndex;
    this.currentBank = bank;
    this.currentBankRevision += 1;
    if (bankIdentityChanged) {
      this.suppressInputUntil = Date.now() + BANK_INPUT_SUPPRESSION_MS;
      this.lastEncoder14BitValues.clear();
    }
    await this.connect();
    this.updateState({
      lastPublishedBankTitle: bank.title,
      lastPublishedBankContextPath: bank.contextPath,
      lastPublishedBankPageIndex: bank.pageIndex,
      lastPublishedSlotLabels: bank.slots.map((slot) => slot.label),
      lastPublishedAtIso: new Date().toISOString()
    });
    if (VERBOSE_TRANSPORT_LOGGING) {
      this.options.log("Publishing Roto bank", {
        title: bank.title,
        contextPath: bank.contextPath,
        pageIndex: bank.pageIndex,
        pageCount: bank.pageCount,
        slotLabels: bank.slots.map((slot) => slot.label)
      });
    }
    this.publishCurrentBankToDevice();
  }

  private async connectInternal(): Promise<RotoControlState> {
    if (this.disposed) {
      return this.state;
    }
    this.updateState({
      connectionPhase: this.state.sysexConnected ? "connected" : "probing"
    });
    await this.ensureMidiConnection();
    await this.ensureSerialConnection();
    this.ensureReconnectLoop();
    return this.state;
  }

  private async ensureMidiConnection(): Promise<void> {
    if (this.midiInput && this.midiOutput) {
      this.updateState({
        midiConnected: true,
        connectionPhase: this.state.sysexConnected ? "connected" : "waiting-for-ping",
        lastError: isTransientMidiError(this.state.lastError) ? null : this.state.lastError
      });
      if (!this.state.sysexConnected) {
        this.sendSysex([GENERAL_TYPE, GENERAL_DAW_STARTED]);
      }
      return;
    }

    const midiBindings = await this.deps.loadMidiBindings();
    if (!midiBindings) {
      this.updateState({
        midiConnected: false,
        sysexConnected: false,
        connectionPhase: this.state.serialConnected ? "probing" : "disconnected",
        midiInputPortName: null,
        midiOutputPortName: null,
        lastError: MIDI_BINDINGS_UNAVAILABLE_MESSAGE
      });
      return;
    }

    try {
      const midiInput = new midiBindings.input();
      const midiOutput = new midiBindings.output();
      midiInput.ignoreTypes(false, false, false);
      const inputIndex = findMatchingPort(midiInput);
      const outputIndex = findMatchingPort(midiOutput);
      if (inputIndex < 0 || outputIndex < 0) {
        midiInput.closePort();
        midiOutput.closePort();
        this.updateState({
          midiConnected: false,
          sysexConnected: false,
          connectionPhase: this.state.serialConnected ? "probing" : "disconnected",
          midiInputPortName: null,
          midiOutputPortName: null,
          lastError: MIDI_PORTS_NOT_FOUND_MESSAGE
        });
        return;
      }

      midiInput.openPort(inputIndex);
      midiOutput.openPort(outputIndex);
      midiInput.on("message", (_delta, message) => {
        this.handleMidiMessage(message);
      });
      this.midiInput = midiInput;
      this.midiOutput = midiOutput;
      this.updateState({
        midiConnected: true,
        connectionPhase: this.state.sysexConnected ? "connected" : "waiting-for-ping",
        midiInputPortName: midiInput.getPortName(inputIndex),
        midiOutputPortName: midiOutput.getPortName(outputIndex),
        lastError: null
      });
      this.sendSysex([GENERAL_TYPE, GENERAL_DAW_STARTED]);
    } catch (error) {
      this.disposeMidiConnections();
      this.options.log("Failed to initialize MIDI bindings", error);
      this.updateState({
        midiConnected: false,
        sysexConnected: false,
        connectionPhase: this.state.serialConnected ? "probing" : "disconnected",
        midiInputPortName: null,
        midiOutputPortName: null,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async ensureSerialConnection(): Promise<void> {
    const serialBindings = await this.deps.loadSerialBindings();
    if (!serialBindings) {
      if (this.serialPort) {
        this.disposeSerialConnection();
      }
      this.updateState({
        serialConnected: false,
        serialPortPath: null,
        serialSelectionReason: SERIAL_BINDINGS_UNAVAILABLE_MESSAGE,
        serialCandidates: [],
        serialAdminState: "idle",
        lastSerialResponseCode: null,
        lastSerialRequestType: null,
        usingCachedProvisionedDefinition: false
      });
      return;
    }

    try {
      const ports = await serialBindings.list();
      const selection = selectSerialPort(ports, this.serialPortOverridePath);
      this.updateState({
        serialCandidates: selection.candidates,
        serialSelectionReason: selection.reason
      });

      if (!selection.selected) {
        if (this.serialPort) {
          this.disposeSerialConnection();
        }
        this.updateState({
          serialConnected: false,
          serialPortPath: null,
          serialAdminState: "idle",
          lastSerialResponseCode: null,
          lastSerialRequestType: null,
          usingCachedProvisionedDefinition: false
        });
        return;
      }

      const selectedPath = selection.selected.entry.path;
      if (this.serialPort && this.state.serialPortPath === selectedPath) {
        this.updateState({
          serialConnected: true,
          serialPortPath: selectedPath,
          serialAdminState:
            this.state.serialAdminState === "provisioning" || this.state.serialAdminState === "cooldown"
              ? this.state.serialAdminState
              : "ready"
        });
        return;
      }

      if (this.serialPort) {
        this.disposeSerialConnection();
      }

      this.serialBuffer = Buffer.alloc(0);
      this.updateState({
        serialAdminState: "opening",
        lastSerialResponseCode: null,
        lastSerialRequestType: null,
        usingCachedProvisionedDefinition: false
      });
      this.serialPort = new serialBindings.SerialPort({
        path: selectedPath,
        baudRate: SERIAL_BAUD_RATE,
        autoOpen: true
      });
      this.serialPort.on("data", (data) => {
        this.handleSerialData(data);
      });
      this.serialPort.on("open", () => {
        this.options.log("Opened Roto serial admin port", { path: selectedPath });
      });
      this.serialPort.on("error", (error) => {
        this.options.log("Roto serial port error", error);
        this.disposeSerialConnection();
        this.updateState({
          serialConnected: false,
          serialPortPath: null,
          serialAdminState: "error",
          usingCachedProvisionedDefinition: false,
          lastError: error?.message ?? "Roto serial port error."
        });
        this.ensureReconnectLoop();
      });
      this.serialPort.on("close", () => {
        this.disposeSerialConnection();
        this.updateState({
          serialConnected: false,
          serialPortPath: null,
          serialAdminState: "idle",
          lastSerialResponseCode: null,
          lastSerialRequestType: null,
          usingCachedProvisionedDefinition: false
        });
        this.ensureReconnectLoop();
      });
      this.updateState({
        serialConnected: true,
        serialPortPath: selectedPath,
        serialAdminState: "ready",
        lastSerialResponseCode: null,
        lastSerialRequestType: null,
        usingCachedProvisionedDefinition: this.lastProvisionedSignature !== null
      });
    } catch (error) {
      this.options.log("Failed to initialize Roto serial bindings", error);
      if (this.serialPort) {
        this.disposeSerialConnection();
      }
      this.updateState({
        serialConnected: false,
        serialPortPath: null,
        serialSelectionReason: error instanceof Error ? error.message : String(error),
        serialAdminState: "error",
        lastSerialResponseCode: null,
        lastSerialRequestType: null,
        usingCachedProvisionedDefinition: false
      });
    }
  }

  private disposeConnections(): void {
    this.clearSerialProvisionTimer();
    this.serialProvisionPromise = null;
    this.serialProvisionScheduledSignature = null;
    this.lastProvisionedSignature = null;
    this.lastProvisionFailedSignature = null;
    this.serialCooldownUntil = 0;
    this.disposeMidiConnections();
    this.disposeSerialConnection();
    this.lastEncoder14BitValues.clear();
    this.updateState({
      available: false,
      midiConnected: false,
      serialConnected: false,
      sysexConnected: false,
      connectionPhase: "disconnected",
      lastError: null,
      midiInputPortName: null,
      midiOutputPortName: null,
      serialPortPath: null,
      serialCandidates: [],
      serialSelectionReason: NO_SERIAL_PORTS_MESSAGE,
      serialAdminState: "idle",
      lastSerialResponseCode: null,
      lastSerialRequestType: null,
      usingCachedProvisionedDefinition: false
    });
  }

  private disposeMidiConnections(): void {
    this.midiInput?.removeAllListeners?.("message");
    this.midiInput?.closePort();
    this.midiOutput?.closePort();
    this.midiInput = null;
    this.midiOutput = null;
  }

  private disposeSerialConnection(): void {
    const activePort = this.serialPort;
    this.serialPort = null;
    this.serialBuffer = Buffer.alloc(0);
    this.clearSerialProvisionTimer();
    this.serialProvisionPromise = null;
    this.serialProvisionScheduledSignature = null;
    this.lastProvisionedSignature = null;
    this.lastProvisionFailedSignature = null;
    this.serialCooldownUntil = 0;
    if (this.pendingSerialResponse) {
      clearTimeout(this.pendingSerialResponse.timeout);
      this.pendingSerialResponse.reject(new Error("Serial admin port closed."));
      this.pendingSerialResponse = null;
    }
    activePort?.close();
  }

  private publishCurrentBankToDevice(): void {
    if (!this.currentBank) {
      return;
    }
    this.scheduleSerialProvision(this.currentBank);
    if (!this.midiOutput || !this.state.sysexConnected) {
      return;
    }
    this.sendRuntimePluginInventory(this.currentBank);
    this.sendCurrentPageValueFeedback(this.currentBank);
  }

  private sendRuntimePluginInventory(bank: RotoControlBank): void {
    const plugin = buildRuntimePluginConfig(bank);
    this.sendSysex(buildNumTracksBody(1));
    this.sendSysex(buildFirstTrackBody(0));
    this.sendSysex(buildTrackDetailsBody(0, "Simularca"));
    this.sendSysex([GENERAL_TYPE, GENERAL_TRACK_DETAILS_END]);
    this.sendSysex([PLUGIN_TYPE, PLUGIN_NUM_DEVICES, 0x01]);
    this.sendSysex([PLUGIN_TYPE, PLUGIN_FIRST_DEVICE, 0x00]);
    this.sendSysex(buildPluginDetailsBody(plugin));
    this.sendSysex([PLUGIN_TYPE, PLUGIN_DEVICE_DETAILS_END]);
    this.sendSysex(buildPluginSelectionBody(0, plugin.pageIndex, false));
  }

  private clearSerialProvisionTimer(): void {
    if (!this.serialProvisionTimer) {
      return;
    }
    this.deps.clearTimeout(this.serialProvisionTimer);
    this.serialProvisionTimer = null;
  }

  private scheduleSerialProvision(bank: RotoControlBank): void {
    if (!this.serialPort || !this.state.serialConnected) {
      this.clearSerialProvisionTimer();
      this.serialProvisionScheduledSignature = null;
      this.updateState({
        serialAdminState: "idle",
        usingCachedProvisionedDefinition: false
      });
      return;
    }
    const signature = provisionSignatureForBank(bank);
    if (signature === this.lastProvisionedSignature) {
      this.clearSerialProvisionTimer();
      this.serialProvisionScheduledSignature = null;
      this.updateState({
        serialAdminState: "ready",
        lastProvisionedSignature: signature,
        usingCachedProvisionedDefinition: true
      });
      return;
    }
    if (signature === this.serialProvisionScheduledSignature || signature === this.lastProvisionFailedSignature) {
      if (Date.now() < this.serialCooldownUntil) {
        this.updateState({
          serialAdminState: "cooldown",
          usingCachedProvisionedDefinition: this.lastProvisionedSignature !== null
        });
        return;
      }
    }
    this.clearSerialProvisionTimer();
    this.serialProvisionScheduledSignature = signature;
    this.serialProvisionTimer = this.deps.setTimeout(() => {
      this.serialProvisionTimer = null;
      if (!this.currentBank) {
        return;
      }
      const nextSignature = provisionSignatureForBank(this.currentBank);
      if (nextSignature !== signature) {
        return;
      }
      void this.ensureProvisionedCurrentBank(this.currentBank, signature);
    }, SERIAL_PROVISION_DEBOUNCE_MS);
  }

  private async ensureProvisionedCurrentBank(bank: RotoControlBank, signature: string): Promise<void> {
    if (!this.serialPort || !this.state.serialConnected) {
      return;
    }
    if (signature === this.lastProvisionedSignature) {
      this.updateState({
        serialAdminState: "ready",
        lastProvisionedSignature: signature,
        usingCachedProvisionedDefinition: true
      });
      return;
    }
    if (Date.now() < this.serialCooldownUntil && signature === this.lastProvisionFailedSignature) {
      this.updateState({
        serialAdminState: "cooldown",
        usingCachedProvisionedDefinition: this.lastProvisionedSignature !== null
      });
      return;
    }
    if (this.serialProvisionPromise) {
      this.scheduleSerialProvision(bank);
      return;
    }
    const attemptAtIso = new Date().toISOString();
    this.serialProvisionPromise = this.provisionCurrentBankOverSerial(bank)
      .then(() => {
        this.lastProvisionedSignature = signature;
        this.lastProvisionFailedSignature = null;
        this.serialCooldownUntil = 0;
        this.updateState({
          serialAdminState: "ready",
          lastProvisionedSignature: signature,
          lastProvisionAttemptAtIso: attemptAtIso,
          lastSerialResponseCode: null,
          lastSerialRequestType: null,
          usingCachedProvisionedDefinition: true,
          lastError: isTransientMidiError(this.state.lastError) ? null : this.state.lastError
        });
      })
      .catch((error) => {
        const nextState: Partial<RotoControlState> = {
          lastProvisionAttemptAtIso: attemptAtIso,
          usingCachedProvisionedDefinition: this.lastProvisionedSignature !== null,
          lastError: error instanceof Error ? error.message : String(error)
        };
        if (error instanceof SerialAdminRequestError) {
          this.lastProvisionFailedSignature = signature;
          nextState.lastSerialResponseCode = `0x${error.responseCode.toString(16).padStart(2, "0")}`;
          nextState.lastSerialRequestType = error.requestType;
          if (isTemporarySerialAdminResponse(error.responseCode)) {
            this.serialCooldownUntil = Date.now() + SERIAL_RETRY_COOLDOWN_MS;
            nextState.serialAdminState = "cooldown";
          } else {
            nextState.serialAdminState = "error";
          }
        } else {
          nextState.serialAdminState = "error";
        }
        this.options.log("Failed to provision Roto bank over serial", {
          error: error instanceof Error ? error.message : String(error),
          signature,
          requestType: error instanceof SerialAdminRequestError ? error.requestType : null,
          responseCode:
            error instanceof SerialAdminRequestError
              ? `0x${error.responseCode.toString(16).padStart(2, "0")}`
              : null
        });
        this.updateState(nextState);
      })
      .finally(() => {
        this.serialProvisionPromise = null;
        if (!this.currentBank) {
          return;
        }
        const latestSignature = provisionSignatureForBank(this.currentBank);
        if (latestSignature !== this.lastProvisionedSignature && latestSignature !== this.serialProvisionScheduledSignature) {
          this.scheduleSerialProvision(this.currentBank);
        }
      });
    this.updateState({
      serialAdminState: "provisioning",
      lastProvisionAttemptAtIso: attemptAtIso,
      usingCachedProvisionedDefinition: this.lastProvisionedSignature !== null
    });
    await this.serialProvisionPromise;
  }

  private async provisionCurrentBankOverSerial(bank: RotoControlBank): Promise<void> {
    const plugin = buildRuntimePluginConfig(bank);
    await this.sendSerialRequest("start-config-update", buildSerialStartConfigUpdateRequest(), 0);
    const pluginLookup = await this.sendSerialRequest("get-plugin", buildSerialPluginGetRequest(plugin), 21, true);
    if (pluginLookup.responseCode === SERIAL_RESPONSE_UNCONFIGURED) {
      await this.sendSerialRequest("add-plugin", buildSerialPluginAddRequest(plugin), 0);
    } else {
      await this.sendSerialRequest("set-plugin-name", buildSerialPluginSetNameRequest(plugin), 0);
    }
    for (const slotConfig of plugin.slots) {
      await this.sendSerialRequest("set-knob-config", buildSerialPluginSetKnobConfigRequest(plugin, slotConfig), 0);
      await this.sendSerialRequest(
        "set-switch-config",
        buildSerialPluginSetSwitchConfigRequest(plugin, buildSerialPluginSwitchConfig(slotConfig)),
        0
      );
    }
    await this.sendSerialRequest("end-config-update", buildSerialEndConfigUpdateRequest(), 0);
  }

  private sendCurrentPageValueFeedback(bank: RotoControlBank): void {
    bank.slots.forEach((slot, slotIndex) => {
      this.sendHiResValueFeedback(slotIndex, slot.normalizedValue);
      this.sendButtonStateFeedback(slotIndex, slot);
      if (slot.kind === "number") {
        this.sendValueStringFeedback(slotIndex, 0x00, slot.valueText);
      } else {
        this.sendValueStringFeedback(slotIndex, 0x01, slot.valueText);
      }
    });
  }

  private sendHiResValueFeedback(slotIndex: number, normalizedValue?: number): void {
    if (!this.midiOutput || slotIndex < 0 || slotIndex >= 8 || typeof normalizedValue !== "number" || !Number.isFinite(normalizedValue)) {
      return;
    }
    const [msb, lsb] = u14To7BitPair(normalizedToU14(normalizedValue));
    this.midiOutput.sendMessage([0xbf, (PLUGIN_ENCODER_MSB_BASE + slotIndex) & 0x7f, msb]);
    this.midiOutput.sendMessage([0xbf, (PLUGIN_ENCODER_LSB_BASE + slotIndex) & 0x7f, lsb]);
  }

  private sendButtonStateFeedback(slotIndex: number, slot: RotoControlSlot): void {
    if (!this.midiOutput || slotIndex < 0 || slotIndex >= 8) {
      return;
    }
    let value = 0;
    if (!slot.disabled) {
      if (slot.kind === "bool") {
        value = (slot.normalizedValue ?? 0) >= 0.5 ? 127 : 0;
      } else if (slot.kind === "enum") {
        value = slot.normalizedValue !== undefined ? clampByte(slot.normalizedValue * 127) : 127;
      } else {
        value = 127;
      }
    }
    this.midiOutput.sendMessage([0xbf, (PLUGIN_BUTTON_CC_BASE + slotIndex) & 0x7f, value]);
  }

  private sendValueStringFeedback(slotIndex: number, controlType: 0x00 | 0x01, valueText?: string): void {
    if (!valueText || !this.midiOutput || slotIndex < 0 || slotIndex >= 8) {
      return;
    }
    this.sendSysex([GENERAL_TYPE, 0x0f, controlType & 0x7f, slotIndex & 0x7f, ...toAscii0D(valueText)]);
  }

  private emitEncoderSet(slotIndex: number, previousValue14Bit: number, nextValue14Bit: number): void {
    const normalizedValue = Math.max(0, Math.min(1, nextValue14Bit / 16383));
    const rawDelta = nextValue14Bit - previousValue14Bit;
    const delta = rawDelta === 0 ? 0 : Math.sign(rawDelta) * Math.max(1, Math.round(Math.abs(rawDelta) / 96));
    this.emitBankInput({
      type: "encoder-set",
      slotIndex,
      normalizedValue,
      delta
    });
  }

  private resolveCurrentSlotByAbsoluteIndex(parameterIndex: number): { slot: RotoControlSlot; localSlotIndex: number } | null {
    if (!this.currentBank) {
      return null;
    }
    const allSlots = getBankSlots(this.currentBank);
    if (parameterIndex < 0 || parameterIndex >= allSlots.length) {
      return null;
    }
    const slot = allSlots[parameterIndex];
    const localSlotIndex = parameterIndex % 8;
    return slot ? { slot, localSlotIndex } : null;
  }

  private async sendSerialRequest(
    requestType: string,
    payload: Buffer,
    expectedBytes: number,
    allowUnconfigured = false
  ): Promise<SerialRequestResult> {
    if (!this.serialPort) {
      throw new Error("Roto serial admin port is not open.");
    }
    const run = async (): Promise<SerialRequestResult> => {
      const result = await new Promise<SerialRequestResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.pendingSerialResponse?.reject === reject) {
            this.pendingSerialResponse = null;
          }
          reject(new Error("Timed out waiting for serial admin response."));
        }, 2000);
        this.pendingSerialResponse = {
          expectedBytes,
          resolve,
          reject,
          timeout
        };
        if (VERBOSE_TRANSPORT_LOGGING) {
          this.options.log("Roto serial request", { payload: [...payload] });
        }
        this.serialPort?.write(payload, (error) => {
          if (!error) {
            return;
          }
          if (this.pendingSerialResponse?.reject === reject) {
            clearTimeout(timeout);
            this.pendingSerialResponse = null;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      if (result.responseCode === SERIAL_RESPONSE_OK) {
        return result;
      }
      if (allowUnconfigured && result.responseCode === SERIAL_RESPONSE_UNCONFIGURED) {
        return result;
      }
      throw new SerialAdminRequestError(requestType, result.responseCode);
    };
    const previous = this.serialRequestChain;
    const resultPromise = previous.then(run, run);
    this.serialRequestChain = resultPromise.then(() => undefined, () => undefined);
    return await resultPromise;
  }

  private handleSerialData(data: Buffer | Uint8Array | number[]): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length === 0) {
      return;
    }
    this.serialBuffer = Buffer.concat([this.serialBuffer, chunk]);
    while (this.serialBuffer.length > 0) {
      if (!this.pendingSerialResponse) {
        this.serialBuffer = Buffer.alloc(0);
        return;
      }
      const markerIndex = this.serialBuffer.indexOf(SERIAL_MESSAGE_RESPONSE);
      if (markerIndex < 0) {
        this.serialBuffer = Buffer.alloc(0);
        return;
      }
      if (markerIndex > 0) {
        this.serialBuffer = this.serialBuffer.subarray(markerIndex);
      }
      if (this.serialBuffer.length < 2) {
        return;
      }
      const responseCode = this.serialBuffer[1] ?? 0;
      const expectedBytes = responseCode === SERIAL_RESPONSE_OK ? this.pendingSerialResponse.expectedBytes : 0;
      if (this.serialBuffer.length < 2 + expectedBytes) {
        return;
      }
      const payload = this.serialBuffer.subarray(2, 2 + expectedBytes);
      this.serialBuffer = this.serialBuffer.subarray(2 + expectedBytes);
      const pending = this.pendingSerialResponse;
      clearTimeout(pending.timeout);
      this.pendingSerialResponse = null;
      pending.resolve({
        responseCode,
        payload
      });
    }
  }

  private updateState(patch: Partial<RotoControlState>): void {
    const nextState = this.normalizeState({
      ...this.state,
      ...patch
    });
    this.state = nextState;
    this.options.emitState(this.state);
  }

  private normalizeState(nextState: RotoControlState): RotoControlState {
    const normalizedState: RotoControlState = {
      ...nextState,
      serialDiscoveryMode: this.serialPortOverridePath ? "manual" : "auto",
      serialPortOverridePath: this.serialPortOverridePath,
      dawEmulation: this.dawEmulation,
      lastProvisionedSignature: this.lastProvisionedSignature
    };
    if (normalizedState.sysexConnected) {
      normalizedState.midiConnected = true;
      normalizedState.connectionPhase = "connected";
    } else if (normalizedState.connectionPhase === "connected") {
      normalizedState.connectionPhase = normalizedState.midiConnected ? "waiting-for-ping" : "disconnected";
    }
    if (!normalizedState.midiConnected) {
      normalizedState.sysexConnected = false;
      if (normalizedState.connectionPhase === "connected" || normalizedState.connectionPhase === "waiting-for-ping") {
        normalizedState.connectionPhase = normalizedState.serialConnected ? "probing" : "disconnected";
      }
    }
    if (!normalizedState.serialConnected && normalizedState.serialAdminState !== "error") {
      normalizedState.serialAdminState = "idle";
      normalizedState.usingCachedProvisionedDefinition = false;
    }
    normalizedState.available =
      normalizedState.midiConnected || normalizedState.serialConnected || normalizedState.sysexConnected;
    normalizedState.requiredDeviceMode = "plugin";
    normalizedState.setupInstructions = this.buildSetupInstructions(normalizedState);
    normalizedState.statusSummary = this.buildStatusSummary(normalizedState);
    return normalizedState;
  }

  private buildSetupInstructions(state: RotoControlState): string[] {
    const instructions = [
      "Connect Roto-Control over USB.",
      "Switch the controller to PLUGIN mode."
    ];
    if (!state.midiConnected) {
      instructions.push("Confirm the ROTO CONTROL DAW MIDI ports are available to the app.");
    }
    if (state.midiConnected && !state.sysexConnected) {
      instructions.push("Leave the device in PLUGIN mode until the DAW handshake completes.");
    }
    if (state.serialCandidates.length > 0 && !state.serialConnected) {
      instructions.push("Serial ports were detected. Use the serial override in plugin properties if the auto-selected port is wrong.");
    } else if (!state.serialConnected) {
      instructions.push("The serial port is optional and only needed for deeper knob configuration.");
    }
    if (state.serialAdminState === "cooldown") {
      instructions.push("The controller rejected a recent admin config request. Waiting briefly before trying again.");
    } else if (state.serialAdminState === "error") {
      instructions.push("Serial admin provisioning failed. The current MIDI session can stay active, but stored control config may be stale.");
    }
    return instructions;
  }

  private buildStatusSummary(state: RotoControlState): string {
    if (state.sysexConnected) {
      return "Roto-Control is connected and the DAW-style plugin session is active.";
    }
    if (state.midiConnected) {
      return "Roto-Control MIDI ports are open, but the DAW handshake has not completed yet. Put the unit in PLUGIN mode.";
    }
    if (state.serialConnected) {
      return "Roto-Control serial access is available, but no DAW MIDI session is active yet.";
    }
    if (state.connectionPhase === "probing") {
      return "Searching for Roto-Control ports.";
    }
    return "Roto-Control is not connected.";
  }

  private ensureReconnectLoop(): void {
    if (this.disposed || !this.connectRequested) {
      this.stopReconnectLoop();
      return;
    }
    if (this.state.sysexConnected && (this.serialPortOverridePath === null || this.state.serialConnected)) {
      this.stopReconnectLoop();
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = this.deps.setInterval(() => {
      if (this.connectPromise || this.disposed || !this.connectRequested) {
        return;
      }
      if (this.state.sysexConnected && (this.serialPortOverridePath === null || this.state.serialConnected)) {
        this.stopReconnectLoop();
        return;
      }
      void this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      this.deps.clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendSysex(data: number[]): void {
    this.midiOutput?.sendMessage(buildSysex(data));
  }

  private emitBankInput<T extends RotoControlInputEvent>(event: T): void {
    this.options.emitInput({
      ...event,
      contextPath: this.currentBank?.contextPath,
      bankRevision: this.currentBankRevision
    } as T & { contextPath?: string; bankRevision?: number });
  }

  private shouldIgnoreInput(): boolean {
    return Date.now() < this.suppressInputUntil;
  }

  private currentDawTypeByte(): number {
    return this.dawEmulation === "bitwig" ? 0x02 : 0x01;
  }

  private handleMidiMessage(message: number[]): void {
    if (message.length === 0) {
      return;
    }
    this.emitBankInput({ type: "raw-midi", data: [...message] });
    const status = message[0] ?? 0;
    if (status === 0xf0) {
      this.handleSysexMessage(message);
      return;
    }
    const command = status & 0xf0;
    const data1 = message[1] ?? 0;
    const data2 = message[2] ?? 0;
    if (command === 0xb0) {
      const encoderMsbIndex = slotIndexFromAbsoluteController(data1, PLUGIN_ENCODER_MSB_BASE);
      if (encoderMsbIndex !== null) {
        const previous = this.lastEncoder14BitValues.get(encoderMsbIndex) ?? 0;
        const next = (((data2 & 0x7f) << 7) | (previous & 0x7f)) & 0x3fff;
        this.lastEncoder14BitValues.set(encoderMsbIndex, next);
        return;
      }
      const encoderLsbIndex = slotIndexFromAbsoluteController(data1, PLUGIN_ENCODER_LSB_BASE);
      if (encoderLsbIndex !== null) {
        const previous = this.lastEncoder14BitValues.get(encoderLsbIndex) ?? 0;
        const next = ((((previous >> 7) & 0x7f) << 7) | (data2 & 0x7f)) & 0x3fff;
        this.lastEncoder14BitValues.set(encoderLsbIndex, next);
        if (!this.shouldIgnoreInput()) {
          this.emitEncoderSet(encoderLsbIndex, previous, next);
        }
        return;
      }
      const slotButtonIndex = slotIndexFromAbsoluteController(data1, PLUGIN_BUTTON_CC_BASE);
      if (slotButtonIndex !== null) {
        if (data2 > 0 && !this.shouldIgnoreInput()) {
          this.emitBankInput({ type: "button-press", slotIndex: slotButtonIndex });
        }
        return;
      }
      const navEvent = NAV_CC_MAP.get(data1);
      if (navEvent && data2 > 0 && !this.shouldIgnoreInput()) {
        this.emitBankInput({ type: navEvent });
        return;
      }
      return;
    }
    if (command === 0x90 && data2 > 0) {
      const noteSlotIndex = slotIndexFromAbsoluteController(data1, PLUGIN_BUTTON_CC_BASE);
      if (noteSlotIndex !== null && !this.shouldIgnoreInput()) {
        this.emitBankInput({ type: "button-press", slotIndex: noteSlotIndex });
      }
    }
  }

  private handleSysexMessage(message: number[]): void {
    if (message.length < SYSEX_PREFIX.length + 3) {
      return;
    }
    for (let index = 0; index < SYSEX_PREFIX.length; index += 1) {
      if ((message[index] ?? -1) !== SYSEX_PREFIX[index]) {
        return;
      }
    }
    const body = message.slice(SYSEX_PREFIX.length, -1);
    const type = body[0];
    const subType = body[1];
    if (type === GENERAL_TYPE && subType === GENERAL_PING_DAW) {
      if (VERBOSE_TRANSPORT_LOGGING) {
        this.options.log("Received Roto DAW ping", { dawEmulation: this.dawEmulation });
      }
      this.sendSysex([GENERAL_TYPE, GENERAL_PING_RESPONSE, this.currentDawTypeByte()]);
      return;
    }
    if (type === GENERAL_TYPE && subType === GENERAL_CONNECTED) {
      this.updateState({
        sysexConnected: true,
        midiConnected: true,
        connectionPhase: "connected",
        lastError: null
      });
      this.sendSysex([GENERAL_TYPE, GENERAL_CONNECTED_ACK]);
      if (this.currentBank) {
        void this.publishCurrentBankToDevice();
      }
      return;
    }
    if (type === PLUGIN_TYPE && subType === PLUGIN_SET_MODE) {
      if (this.currentBank) {
        void this.publishCurrentBankToDevice();
      }
      return;
    }
    if (type === PLUGIN_TYPE && subType === PLUGIN_DAW_SELECT_PLUGIN) {
      const payload = body.slice(2);
      if (!this.shouldIgnoreInput()) {
        this.emitBankInput({
        type: "page-select",
        pageIndex: payload[1] ?? 0
        });
      }
      return;
    }
    if (type === PLUGIN_TYPE && subType === PLUGIN_CONTROL_MAPPED) {
      const payload = body.slice(2);
      const parameterIndex = (((payload[0] ?? 0) & 0x7f) << 7) | ((payload[1] ?? 0) & 0x7f);
      const controlType = payload[8] ?? 0;
      const controlIndex = payload[9] ?? 0;
      const pageIndex = payload[7] ?? 0;
      const resolvedSlot = this.resolveCurrentSlotByAbsoluteIndex(parameterIndex);
      if (!resolvedSlot) {
        if (INPUT_SUPPRESSION_LOGGING || VERBOSE_TRANSPORT_LOGGING) {
          this.options.log("Ignoring CONTROL_MAPPED for unknown slot", {
            parameterIndex,
            controlIndex,
            pageIndex
          });
        }
        return;
      }
      if (VERBOSE_TRANSPORT_LOGGING) {
        this.options.log("Responding to CONTROL_MAPPED", {
          parameterIndex,
          controlIndex,
          controlType,
          slotLabel: resolvedSlot.slot.label
        });
      }
      if (controlType === 0x00) {
        this.sendSysex(buildLearnParamBody(resolvedSlot.slot, parameterIndex));
        this.sendHiResValueFeedback(controlIndex, resolvedSlot.slot.normalizedValue);
        this.sendValueStringFeedback(controlIndex, 0x00, resolvedSlot.slot.valueText);
        return;
      }
      if (controlType === 0x01) {
        this.sendButtonStateFeedback(controlIndex, resolvedSlot.slot);
        this.sendValueStringFeedback(controlIndex, 0x01, resolvedSlot.slot.valueText);
      }
    }
  }
}

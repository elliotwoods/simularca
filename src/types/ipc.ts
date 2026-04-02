export type AppMode = "electron-rw" | "web-ro";

export interface DefaultProjectPointer {
  defaultProjectName: string;
  defaultSnapshotName: string;
}

export interface ProjectSnapshotListEntry {
  name: string;
  updatedAtIso: string | null;
}

export interface ProjectAssetRef {
  id: string;
  kind: "hdri" | "generic" | "image";
  encoding?: "raw" | "ktx2";
  relativePath: string;
  sourceFileName: string;
  byteSize: number;
}

export interface DaeImportResult {
  asset: ProjectAssetRef;
  imageAssets: ProjectAssetRef[];
  materialDefs: Array<{
    id: string;
    name: string;
    albedo: { mode: "color"; color: string } | { mode: "image"; assetId: string };
    roughness: number;
    metalness: number;
    normalMapAssetId: string | null;
    emissive: string;
  }>;
  materialSlots: Record<string, string>;
}

export interface HdriTranscodeOptions {
  uastc?: boolean;
  zstdLevel?: number;
  generateMipmaps?: boolean;
}

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface SaveDialogArgs {
  title?: string;
  defaultFileName?: string;
  filters?: FileDialogFilter[];
}

export interface DirectoryDialogArgs {
  title?: string;
}

export interface ExternalPluginCandidate {
  modulePath: string;
  sourceGroup: "plugins-external" | "plugins";
  updatedAtMs: number;
  version: string;
}

export interface GitDirtyBadge {
  repoRoot: string;
  changedFileCount: number;
}

export interface GitDirtyStatusRequest {
  pluginModulePaths: string[];
}

export interface GitDirtyStatusResponse {
  app: GitDirtyBadge | null;
  plugins: Record<string, GitDirtyBadge | null>;
}

export interface LiveDebugExecutionSuccess {
  ok: true;
  summary: string;
  result?: unknown;
  details?: string;
}

export interface LiveDebugExecutionError {
  ok: false;
  summary: string;
  error: string;
  details?: string;
}

export type LiveDebugExecutionResult = LiveDebugExecutionSuccess | LiveDebugExecutionError;

export interface RendererDebugExecuteRequest {
  source: string;
  mode: "console" | "eval";
  windowId?: number;
}

export interface MainDebugExecuteRequest {
  source: string;
}

export interface CodexDebugSessionWindowInfo {
  id: number;
  title: string;
  url: string;
  focused: boolean;
  visible: boolean;
}

export interface CodexDebugSessionManifest {
  pid: number;
  startedAtIso: string;
  port: number;
  token: string;
  baseUrl: string;
  windowIds: number[];
  build: {
    appVersion: string;
    buildKind: "dev" | "build";
    electronVersion: string;
    nodeVersion: string;
  };
}

export interface RendererDebugSessionInfo {
  ready: boolean;
  buildKind: string;
  activeProjectName: string;
  activeSnapshotName: string;
  mode: string;
  selection: Array<{ kind: string; id: string }>;
  actorCount: number;
  componentCount: number;
  statusMessage: string;
}

export interface RendererDebugBridge {
  executeConsole(source: string): Promise<LiveDebugExecutionResult>;
  executeEval(source: string): Promise<LiveDebugExecutionResult>;
  sessionInfo(): RendererDebugSessionInfo;
}

export interface RenderPipeState {
  pipeId: string;
  acceptedFrameCount: number;
  writtenFrameCount: number;
  queuedBytes: number;
  queueBudgetBytes: number;
  error?: string;
  closed?: boolean;
}

export type RotoControlColorRole =
  | "default"
  | "translate"
  | "rotate"
  | "scale"
  | "enum"
  | "toggle"
  | "drill"
  | "action"
  | "zoom";

export type RotoControlSlotKind = "number" | "enum" | "bool" | "action";

export interface RotoControlSlot {
  id: string;
  label: string;
  kind: RotoControlSlotKind;
  colorRole: RotoControlColorRole;
  valueText?: string;
  stepLabels?: string[];
  normalizedValue?: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  enumLabels?: string[];
  centered?: boolean;
  disabled?: boolean;
  quantizedStepCount?: number;
}

export interface RotoControlBank {
  title: string;
  contextPath: string;
  pageIndex: number;
  pageCount: number;
  slots: RotoControlSlot[];
  allSlots?: RotoControlSlot[];
  zoomTargetSlotId?: string | null;
}

export interface RotoControlSerialCandidate {
  path: string;
  friendlyName?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  selected: boolean;
}

export type RotoControlDawEmulation = "ableton" | "bitwig";

export interface RotoControlState {
  available: boolean;
  midiConnected: boolean;
  serialConnected: boolean;
  sysexConnected: boolean;
  lastError?: string | null;
  inputMode: "plugin" | "midi";
  connectionPhase: "disconnected" | "probing" | "waiting-for-ping" | "connected";
  requiredDeviceMode: "plugin";
  statusSummary: string;
  setupInstructions: string[];
  midiInputPortName?: string | null;
  midiOutputPortName?: string | null;
  serialPortPath?: string | null;
  serialDiscoveryMode: "auto" | "manual";
  serialPortOverridePath?: string | null;
  serialSelectionReason: string;
  serialCandidates: RotoControlSerialCandidate[];
  dawEmulation: RotoControlDawEmulation;
  serialAdminState: "idle" | "opening" | "ready" | "provisioning" | "cooldown" | "error";
  lastProvisionedSignature?: string | null;
  lastProvisionAttemptAtIso?: string | null;
  lastSerialResponseCode?: string | null;
  lastSerialRequestType?: string | null;
  usingCachedProvisionedDefinition: boolean;
  lastPublishedBankTitle?: string | null;
  lastPublishedBankContextPath?: string | null;
  lastPublishedBankPageIndex?: number | null;
  lastPublishedSlotLabels?: string[];
  lastPublishedAtIso?: string | null;
}

interface RotoControlInputEventBase {
  contextPath?: string;
  bankRevision?: number;
}

export type RotoControlInputEvent =
  | (RotoControlInputEventBase & { type: "encoder-turn"; slotIndex: number; delta: number })
  | (RotoControlInputEventBase & { type: "encoder-set"; slotIndex: number; normalizedValue: number; delta?: number })
  | (RotoControlInputEventBase & { type: "button-press"; slotIndex: number })
  | (RotoControlInputEventBase & { type: "page-select"; pageIndex: number })
  | (RotoControlInputEventBase & { type: "page-next" })
  | (RotoControlInputEventBase & { type: "page-prev" })
  | (RotoControlInputEventBase & { type: "navigate-back" })
  | (RotoControlInputEventBase & { type: "navigate-forward" })
  | (RotoControlInputEventBase & { type: "raw-midi"; data: number[] });

export interface ElectronApi {
  mode: AppMode;
  getPathForFile(file: File): string | null;
  listProjects(): Promise<string[]>;
  listSnapshots(projectName: string): Promise<ProjectSnapshotListEntry[]>;
  loadDefaults(): Promise<DefaultProjectPointer>;
  saveDefaults(pointer: DefaultProjectPointer): Promise<void>;
  loadProjectSnapshot(args: { projectName: string; snapshotName: string }): Promise<string>;
  saveProjectSnapshot(args: { projectName: string; snapshotName: string; payload: string }): Promise<void>;
  cloneProject(args: { previousName: string; nextName: string }): Promise<void>;
  deleteProject(args: { projectName: string }): Promise<void>;
  renameProject(args: { previousName: string; nextName: string }): Promise<void>;
  duplicateSnapshot(args: { projectName: string; previousName: string; nextName: string }): Promise<void>;
  renameSnapshot(args: { projectName: string; previousName: string; nextName: string }): Promise<void>;
  deleteSnapshot(args: { projectName: string; snapshotName: string }): Promise<void>;
  importAsset(args: {
    projectName: string;
    sourcePath: string;
    kind: ProjectAssetRef["kind"];
  }): Promise<ProjectAssetRef>;
  importDae(args: { projectName: string; sourcePath: string }): Promise<DaeImportResult>;
  transcodeHdriToKtx2(args: {
    projectName: string;
    sourcePath: string;
    options?: HdriTranscodeOptions;
  }): Promise<ProjectAssetRef>;
  deleteAsset(args: { projectName: string; relativePath: string }): Promise<void>;
  resolveAssetPath(args: { projectName: string; relativePath: string }): Promise<string>;
  readAssetBytes(args: { projectName: string; relativePath: string }): Promise<Uint8Array>;
  openFileDialog(args: { title?: string; filters?: FileDialogFilter[] }): Promise<string | null>;
  openSaveDialog(args: SaveDialogArgs): Promise<string | null>;
  openDirectoryDialog(args: DirectoryDialogArgs): Promise<string | null>;
  discoverExternalPlugins(): Promise<ExternalPluginCandidate[]>;
  getGitDirtyStatus(args: GitDirtyStatusRequest): Promise<GitDirtyStatusResponse>;
  writeClipboardImagePng(args: { pngBytes: Uint8Array }): Promise<void>;
  renderPipeOpen(args: {
    outputPath: string;
    fps: number;
    bitrateMbps: number;
  }): Promise<{ pipeId: string; encoder: string; queueBudgetBytes: number }>;
  renderPipeWriteFrame(args: { pipeId: string; framePngBytes: Uint8Array }): void;
  renderPipeClose(args: { pipeId: string }): Promise<{ summary: string }>;
  renderPipeAbort(args: { pipeId: string }): Promise<void>;
  onRenderPipeState(listener: (state: RenderPipeState) => void): () => void;
  renderTempInit(args: {
    folderPath: string;
    fps: number;
    bitrateMbps: number;
    outputFileName?: string;
    frameFolderName?: string;
  }): Promise<{ jobId: string; frameFolderPath: string; outputPath: string; encoder: string }>;
  renderTempWriteFrame(args: { jobId: string; frameIndex: number; framePngBytes: Uint8Array }): Promise<void>;
  renderTempFinalize(args: { jobId: string }): Promise<{ summary: string }>;
  renderTempAbort(args: { jobId: string }): Promise<void>;
  logRuntimeError(payload: Record<string, unknown>): void;
  getWindowState(): Promise<{ isMaximized: boolean; isFullscreen: boolean }>;
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowSetFullscreen(fullscreen: boolean): Promise<{ isMaximized: boolean; isFullscreen: boolean }>;
  windowClose(): Promise<void>;
  showAppMenu(args: { x: number; y: number }): Promise<void>;
  onWindowStateChange(listener: (state: { isMaximized: boolean; isFullscreen: boolean }) => void): () => void;
  rotoControlConnect(): Promise<RotoControlState>;
  rotoControlRefresh(): Promise<RotoControlState>;
  rotoControlSetSerialOverride(path: string | null): Promise<RotoControlState>;
  rotoControlSetDawEmulation(mode: RotoControlDawEmulation): Promise<RotoControlState>;
  rotoControlPublishBank(bank: RotoControlBank): Promise<void>;
  onRotoControlState(listener: (state: RotoControlState) => void): () => void;
  onRotoControlInput(listener: (event: RotoControlInputEvent) => void): () => void;
}

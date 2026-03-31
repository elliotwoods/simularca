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
}

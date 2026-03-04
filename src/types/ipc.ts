export type AppMode = "electron-rw" | "web-ro";

export interface DefaultSessionPointer {
  defaultSessionName: string;
}

export interface SessionAssetRef {
  id: string;
  kind: "hdri" | "gaussian-splat" | "generic" | "image";
  encoding?: "raw" | "ktx2" | "splatbin-v1";
  relativePath: string;
  sourceFileName: string;
  byteSize: number;
}

export interface DaeImportResult {
  asset: SessionAssetRef;
  imageAssets: SessionAssetRef[];
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

export interface LocalPluginCandidate {
  modulePath: string;
  sourceGroup: "plugins-local" | "plugins";
}

export interface ElectronApi {
  mode: AppMode;
  listSessions(): Promise<string[]>;
  loadDefaults(): Promise<DefaultSessionPointer>;
  saveDefaults(pointer: DefaultSessionPointer): Promise<void>;
  loadSession(sessionName: string): Promise<string>;
  saveSession(sessionName: string, payload: string): Promise<void>;
  cloneSession(args: { previousName: string; nextName: string }): Promise<void>;
  renameSession(args: { previousName: string; nextName: string }): Promise<void>;
  importAsset(args: {
    sessionName: string;
    sourcePath: string;
    kind: SessionAssetRef["kind"];
  }): Promise<SessionAssetRef>;
  importDae(args: { sessionName: string; sourcePath: string }): Promise<DaeImportResult>;
  importGaussianSplat(args: {
    sessionName: string;
    sourcePath: string;
  }): Promise<SessionAssetRef>;
  convertGaussianAsset(args: {
    sessionName: string;
    assetId: string;
    relativePath: string;
    sourceFileName: string;
  }): Promise<SessionAssetRef>;
  transcodeHdriToKtx2(args: {
    sessionName: string;
    sourcePath: string;
    options?: HdriTranscodeOptions;
  }): Promise<SessionAssetRef>;
  deleteAsset(args: { sessionName: string; relativePath: string }): Promise<void>;
  resolveAssetPath(args: { sessionName: string; relativePath: string }): Promise<string>;
  readAssetBytes(args: { sessionName: string; relativePath: string }): Promise<Uint8Array>;
  openFileDialog(args: { title?: string; filters?: FileDialogFilter[] }): Promise<string | null>;
  openSaveDialog(args: SaveDialogArgs): Promise<string | null>;
  openDirectoryDialog(args: DirectoryDialogArgs): Promise<string | null>;
  discoverLocalPlugins(): Promise<LocalPluginCandidate[]>;
  renderPipeOpen(args: { outputPath: string; fps: number; bitrateMbps: number }): Promise<{ pipeId: string; encoder: string }>;
  renderPipeWriteFrame(args: { pipeId: string; framePngBytes: Uint8Array }): Promise<void>;
  renderPipeClose(args: { pipeId: string }): Promise<{ summary: string }>;
  renderPipeAbort(args: { pipeId: string }): Promise<void>;
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
  getWindowState(): Promise<{ isMaximized: boolean }>;
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  showAppMenu(args: { x: number; y: number }): Promise<void>;
  onWindowStateChange(listener: (state: { isMaximized: boolean }) => void): () => void;
}


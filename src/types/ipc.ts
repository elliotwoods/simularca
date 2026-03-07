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

export interface LocalPluginCandidate {
  modulePath: string;
  sourceGroup: "plugins-local" | "plugins";
}

export interface ElectronApi {
  mode: AppMode;
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

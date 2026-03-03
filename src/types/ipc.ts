export type AppMode = "electron-rw" | "web-ro";

export interface DefaultSessionPointer {
  defaultSessionName: string;
}

export interface SessionAssetRef {
  id: string;
  kind: "hdri" | "gaussian-splat" | "generic";
  encoding?: "raw" | "ktx2" | "splatbin-v1";
  relativePath: string;
  sourceFileName: string;
  byteSize: number;
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

export interface ElectronApi {
  mode: AppMode;
  listSessions(): Promise<string[]>;
  loadDefaults(): Promise<DefaultSessionPointer>;
  saveDefaults(pointer: DefaultSessionPointer): Promise<void>;
  loadSession(sessionName: string): Promise<string>;
  saveSession(sessionName: string, payload: string): Promise<void>;
  renameSession(args: { previousName: string; nextName: string }): Promise<void>;
  importAsset(args: {
    sessionName: string;
    sourcePath: string;
    kind: SessionAssetRef["kind"];
  }): Promise<SessionAssetRef>;
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
  logRuntimeError(payload: Record<string, unknown>): void;
  getWindowState(): Promise<{ isMaximized: boolean }>;
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  showAppMenu(args: { x: number; y: number }): Promise<void>;
  onWindowStateChange(listener: (state: { isMaximized: boolean }) => void): () => void;
}


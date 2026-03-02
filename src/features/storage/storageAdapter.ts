import type { DefaultSessionPointer, SessionAssetRef } from "@/types/ipc";

export interface StorageAdapter {
  readonly mode: "electron-rw" | "web-ro";
  readonly isReadOnly: boolean;
  listSessions(): Promise<string[]>;
  loadDefaults(): Promise<DefaultSessionPointer>;
  saveDefaults(pointer: DefaultSessionPointer): Promise<void>;
  loadSession(sessionName: string): Promise<string>;
  saveSession(sessionName: string, payload: string): Promise<void>;
  renameSession(previousName: string, nextName: string): Promise<void>;
  importAsset(args: {
    sessionName: string;
    sourcePath: string;
    kind: SessionAssetRef["kind"];
  }): Promise<SessionAssetRef>;
  transcodeHdriToKtx2(args: {
    sessionName: string;
    sourcePath: string;
    options?: {
      uastc?: boolean;
      zstdLevel?: number;
      generateMipmaps?: boolean;
    };
  }): Promise<SessionAssetRef>;
  deleteAsset(args: { sessionName: string; relativePath: string }): Promise<void>;
  resolveAssetPath(args: { sessionName: string; relativePath: string }): Promise<string>;
}


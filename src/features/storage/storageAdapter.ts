import type { DaeImportResult, DefaultProjectPointer, ProjectAssetRef, ProjectSnapshotListEntry } from "@/types/ipc";

export interface StorageAdapter {
  readonly mode: "electron-rw" | "web-ro";
  readonly isReadOnly: boolean;
  listProjects(): Promise<string[]>;
  listSnapshots(projectName: string): Promise<ProjectSnapshotListEntry[]>;
  loadDefaults(): Promise<DefaultProjectPointer>;
  saveDefaults(pointer: DefaultProjectPointer): Promise<void>;
  loadProjectSnapshot(projectName: string, snapshotName: string): Promise<string>;
  saveProjectSnapshot(projectName: string, snapshotName: string, payload: string): Promise<void>;
  cloneProject(previousName: string, nextName: string): Promise<void>;
  deleteProject(projectName: string): Promise<void>;
  renameProject(previousName: string, nextName: string): Promise<void>;
  duplicateSnapshot(projectName: string, previousName: string, nextName: string): Promise<void>;
  renameSnapshot(projectName: string, previousName: string, nextName: string): Promise<void>;
  deleteSnapshot(projectName: string, snapshotName: string): Promise<void>;
  importAsset(args: {
    projectName: string;
    sourcePath: string;
    kind: ProjectAssetRef["kind"];
  }): Promise<ProjectAssetRef>;
  importDae(args: { projectName: string; sourcePath: string }): Promise<DaeImportResult>;
  transcodeHdriToKtx2(args: {
    projectName: string;
    sourcePath: string;
    options?: {
      uastc?: boolean;
      zstdLevel?: number;
      generateMipmaps?: boolean;
    };
  }): Promise<ProjectAssetRef>;
  deleteAsset(args: { projectName: string; relativePath: string }): Promise<void>;
  resolveAssetPath(args: { projectName: string; relativePath: string }): Promise<string>;
  readAssetBytes(args: { projectName: string; relativePath: string }): Promise<Uint8Array>;
}

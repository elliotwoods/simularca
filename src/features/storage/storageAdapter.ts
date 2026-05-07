import type {
  AppMode,
  DaeImportResult,
  DefaultProjectPointer,
  HdriTranscodeOptions,
  LegacyProjectInfo,
  OpenProjectResult,
  ProjectAssetRef,
  ProjectIdentity,
  ProjectionCacheFileV1,
  ProjectSnapshotListEntry,
  RecentsEntry
} from "@/types/ipc";

export interface StorageAdapter {
  readonly mode: AppMode;
  readonly isReadOnly: boolean;

  // Recents and defaults (app-internal state).
  loadRecents(): Promise<RecentsEntry[]>;
  saveRecents(entries: RecentsEntry[]): Promise<void>;
  removeRecent(uuid: string): Promise<void>;
  locateRecent(uuid: string, title?: string): Promise<RecentsEntry | null>;
  loadDefaults(): Promise<DefaultProjectPointer | null>;
  saveDefaults(pointer: DefaultProjectPointer | null): Promise<void>;

  // File-system dialogs.
  selectSimularcaFile(title?: string): Promise<string | null>;
  selectFolder(args?: { title?: string; defaultPath?: string }): Promise<string | null>;
  getDefaultProjectsRoot(): Promise<string>;

  // Project lifecycle.
  createNewProject(args: {
    parentFolder?: string;
    projectName: string;
    initialSnapshotPayload: string;
  }): Promise<ProjectIdentity>;
  openProject(simularcaPath: string): Promise<OpenProjectResult>;
  saveProjectAs(args: {
    currentPath: string;
    newParentFolder: string;
    newProjectName: string;
  }): Promise<ProjectIdentity>;
  moveProject(args: { currentPath: string; newParentFolder: string }): Promise<ProjectIdentity>;
  renameProject(args: { currentPath: string; newProjectName: string }): Promise<ProjectIdentity>;
  deleteProject(projectPath: string): Promise<void>;
  repairPointer(folderPath: string): Promise<ProjectIdentity>;

  // Snapshot lifecycle.
  listSnapshots(projectPath: string): Promise<ProjectSnapshotListEntry[]>;
  loadSnapshot(projectPath: string, snapshotName: string): Promise<string>;
  saveSnapshot(projectPath: string, snapshotName: string, payload: string): Promise<void>;
  duplicateSnapshot(projectPath: string, previousName: string, nextName: string): Promise<void>;
  renameSnapshot(projectPath: string, previousName: string, nextName: string): Promise<void>;
  deleteSnapshot(projectPath: string, snapshotName: string): Promise<void>;

  // Migration.
  detectLegacyProjects(): Promise<LegacyProjectInfo[]>;
  migrateLegacyProject(args: { legacyName: string; targetParentFolder: string }): Promise<ProjectIdentity>;
  writeMigrationReadme(args: {
    failedProjectNames: string[];
    skippedProjectNames: string[];
  }): Promise<void>;
  deleteLegacyProject(legacyName: string): Promise<void>;

  // Assets.
  importAsset(args: {
    projectPath: string;
    sourcePath: string;
    kind: ProjectAssetRef["kind"];
  }): Promise<ProjectAssetRef>;
  writeGeneratedAsset(args: {
    projectPath: string;
    bytes: Uint8Array;
    fileName: string;
    kind: ProjectAssetRef["kind"];
  }): Promise<ProjectAssetRef>;
  importDae(args: { projectPath: string; sourcePath: string }): Promise<DaeImportResult>;
  transcodeHdriToKtx2(args: {
    projectPath: string;
    sourcePath: string;
    options?: HdriTranscodeOptions;
  }): Promise<ProjectAssetRef>;
  deleteAsset(args: { projectPath: string; relativePath: string }): Promise<void>;
  resolveAssetPath(args: { projectUuid: string; relativePath: string }): Promise<string>;
  readAssetBytes(args: { projectPath: string; relativePath: string }): Promise<Uint8Array>;

  // Per-project derived caches.
  readProjectionCache(projectPath: string): Promise<ProjectionCacheFileV1 | null>;
  writeProjectionCache(projectPath: string, payload: ProjectionCacheFileV1): Promise<void>;
}

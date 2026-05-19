export type AppMode = "electron-rw" | "web-ro";

export const POINTER_SCHEMA_VERSION = 1;
export const SIMULARCA_EXTENSION = ".simularca";
export const DEFAULT_PROJECTS_FOLDER_NAME = "Simularca Projects";

/**
 * On-disk pointer file content (`<ProjectName>.simularca`).
 * Source of truth for the project's stable UUID.
 */
export interface ProjectPointer {
  uuid: string;
  pointerSchemaVersion: 1;
  format: "folder";
}

/**
 * In-memory identity of an opened project.
 * `name` is derived from the `.simularca` filename; `path` is the absolute
 * path to that file; `uuid` is read from the pointer's contents.
 */
export interface ProjectIdentity {
  uuid: string;
  path: string;
  name: string;
}

export interface RecentsEntry {
  uuid: string;
  path: string;
  cachedName: string;
  lastOpenedAtIso: string;
  lastSnapshotName: string | null;
}

export interface DefaultProjectPointer {
  uuid: string;
  path: string;
  lastSnapshotName: string | null;
}

/** Pre-redesign defaults shape, kept for migration only. */
export interface LegacyDefaultProjectPointer {
  defaultProjectName: string;
  defaultSnapshotName: string;
}

export interface ProjectSnapshotListEntry {
  name: string;
  updatedAtIso: string | null;
}

export interface LegacyProjectInfo {
  legacyName: string;
  snapshotCount: number;
  totalBytes: number;
}

export interface OpenProjectResult {
  identity: ProjectIdentity;
  snapshots: ProjectSnapshotListEntry[];
  lastSnapshotName: string | null;
}

export interface ProjectAssetRef {
  id: string;
  kind: "hdri" | "generic" | "image";
  encoding?: "raw" | "ktx2";
  relativePath: string;
  sourceFileName: string;
  byteSize: number;
  /** When set, this asset is a decimated LOD of the asset with this id. */
  lodOf?: string;
  /** Target ratio (0-1) used to generate the LOD relative to the parent. */
  lodRatio?: number;
  /** Triangle count of the generated LOD geometry. */
  lodTriangleCount?: number;
  /** Triangle count of the parent asset at the time of generation. */
  lodOriginalTriangleCount?: number;
}

export interface ProjectionCacheEntryV1 {
  signature: string;
  polyline: {
    points: ([number, number, number] | null)[];
    hitCount: number;
    resolution: number;
    targetCount: number;
  };
  updatedAtIso?: string;
}

export interface ProjectionCacheFileV1 {
  version: 1;
  entries: Record<string, ProjectionCacheEntryV1>;
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

// ----------------------------------------------------------------------
// Publish-to-web (snapshots → user's R2 bucket → central viewer)
// ----------------------------------------------------------------------

export interface RedactedR2Credentials {
  accountId: string;
  accessKeyId: string;
  bucket: string;
  region?: string;
  hasSecret: boolean;
}

export interface RedactedSelfHostedViewer {
  hasVercelToken: boolean;
  vercelProjectId?: string;
  vercelTeamId?: string;
}

export interface RedactedPublishTarget {
  id: string;
  label: string;
  r2: RedactedR2Credentials;
  bucketBaseUrl: string;
  viewerUrl: string;
  selfHosted?: RedactedSelfHostedViewer;
  manifestRetention?: number;
}

export interface ListedPublish {
  publishId: string;
  title: string;
  lastPublishedAtIso: string;
  targetId: string;
  viewerUrl?: string;
  requiredViewerSha?: string;
  referencedBlobs: PublishBlobRef[];
}

export interface RedactedPublishSettings {
  schemaVersion: number;
  targets: RedactedPublishTarget[];
  defaultTargetId?: string;
  publishesByProjectUuid: Record<string, ListedPublish[]>;
  viewerDeployment?: RedactedVercelDeploySettings;
  /** Saved publish layout (flexlayout IJsonModel); validated/cast at use site. */
  defaultPublishLayout?: unknown;
  /** Saved viewer permission defaults; validated/cast at use site. */
  defaultViewerPermissions?: unknown;
}

/**
 * Inputs for `publish:saveSettings`. Plaintext secrets travel only renderer→
 * main and only as part of a save (never returned via load).
 */
export interface PublishTargetSecrets {
  /** Inserted only when (re)setting credentials; omit to keep existing. */
  r2SecretAccessKey?: string;
  /** Inserted only when (re)setting; omit to keep existing. */
  vercelToken?: string;
}

export interface PublishTargetWriteRequest {
  id: string;
  label: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    bucket: string;
    region?: string;
  };
  bucketBaseUrl: string;
  viewerUrl: string;
  selfHosted?: {
    vercelProjectId?: string;
    vercelTeamId?: string;
  };
  manifestRetention?: number;
  secrets?: PublishTargetSecrets;
}

export interface PublishViewerConfig {
  configVersion: 1;
  panels: {
    sceneTree: boolean;
    inspector: boolean;
    console: boolean;
    snapshotPicker: boolean;
  };
  interactions: {
    transformGizmo: boolean;
    axisWidget: boolean;
    viewPresets: boolean;
    postProcessing: boolean;
    orbitPanZoom: boolean;
  };
  permissions: {
    canEditParameters: boolean;
    canToggleVisibility: boolean;
    canCreateActors: boolean;
    canDeleteActors: boolean;
    canTransformActors: boolean;
  };
  /** Optional FlexLayout IJsonModel chosen by the publisher. Opaque to the main process. */
  layout?: unknown;
  branding: { title?: string };
}

export interface PublishStartRequest {
  projectPath: string;
  snapshotNames: string[];
  title: string;
  viewerConfig: PublishViewerConfig;
  targetId: string;
  publishId?: string;
  /** Override the editor's current commit sha — used by "Use last deployed viewer". */
  requiredViewerShaOverride?: string;
  /**
   * Optional social-card / OpenGraph thumbnail captured from the editor's
   * viewport at publish time. The renderer encodes it as JPEG; the publish
   * service uploads it to the bucket and records the URL in
   * `manifest.thumbnail`.
   */
  thumbnail?: {
    bytes: Uint8Array;
    width: number;
    height: number;
    contentType: string;
  };
}

export interface PublishStartAck {
  jobId: string;
}

export type PublishProgressPhase =
  | "preflight"
  | "snapshot-scan"
  | "plugin-bundle"
  | "asset-hash"
  | "existence-check"
  | "asset-upload"
  | "plugin-upload"
  | "snapshot-upload"
  | "config-upload"
  | "manifest-upload"
  | "switch-live"
  | "gc"
  | "done"
  | "error";

export interface PublishProgressEvent {
  jobId: string;
  phase: PublishProgressPhase;
  current?: number;
  total?: number;
  currentItem?: string;
  message?: string;
  /** Monotonic 0..1 across the entire publish. Use this to drive the UI bar. */
  overallProgress?: number;
  viewerUrl?: string;
  manifestSha?: string;
  error?: string;
}

export interface PublishCheckViewerVersionRequest {
  targetId: string;
  sha: string;
  /**
   * Optional retry budget. The renderer passes a non-zero value right after
   * a successful viewer deploy because Vercel's production-alias swap can
   * lag 5–30s behind the deploy "ready" signal, during which a HEAD against
   * the production URL still returns 404.
   */
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface PublishCheckViewerVersionResult {
  deployed: boolean;
  status?: number;
  error?: string;
}

export interface PublishRollbackRequest {
  targetId: string;
  publishId: string;
  manifestSha: string;
}

export type ValidationField =
  | "label"
  | "accountId"
  | "accessKeyId"
  | "secretAccessKey"
  | "bucket"
  | "region"
  | "bucketBaseUrl"
  | "viewerUrl"
  | "vercelToken"
  | "vercelProjectId"
  | "general";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  field: ValidationField;
  severity: ValidationSeverity;
  message: string;
}

export interface VerifyTargetResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface RedactedVercelDeploySettings {
  hasVercelToken: boolean;
  vercelProjectId?: string;
  vercelProjectName?: string;
  vercelTeamId?: string;
  cachedAccountLabel?: string;
  lastVerifiedAtIso?: string;
  lastDeployedSha?: string;
  lastDeployedAtIso?: string;
}

export interface PublishBlobRef {
  sha: string;
  key: string;
  byteSize: number;
  kind: "asset" | "plugin" | "snapshot" | "config" | "manifest" | "latest" | "thumbnail";
}

export interface VercelTokenVerifyResult {
  ok: boolean;
  email?: string;
  username?: string;
  userId?: string;
  teamSlug?: string;
  error?: string;
}

export interface VercelSettingsWriteRequest {
  token?: string;
  clear?: boolean;
  projectName?: string;
  projectId?: string;
  teamId?: string;
}

export type DeployViewerPhase =
  | "build"
  | "project"
  | "deploy"
  | "ready"
  | "done"
  | "error";

export interface DeployViewerProgressEvent {
  jobId: string;
  phase: DeployViewerPhase;
  message?: string;
  uploadedFiles?: number;
  totalFiles?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  url?: string;
  error?: string;
}

export interface PublishDeleteResult {
  settings: RedactedPublishSettings;
  bytesFreed: number;
  deletedBlobCount: number;
  /** Of the deleted blobs, how many were content-addressed (assets/plugins). */
  deletedSharedCount: number;
  /** Shared blobs that were RETAINED because another publish still references them. */
  retainedSharedCount: number;
  failedKeyCount: number;
}

export interface PublishApi {
  loadSettings(): Promise<RedactedPublishSettings>;
  saveSettings(args: {
    targets: PublishTargetWriteRequest[];
    defaultTargetId?: string;
  }): Promise<RedactedPublishSettings>;
  listForProject(args: { projectUuid: string }): Promise<ListedPublish[]>;
  checkViewerVersion(args: PublishCheckViewerVersionRequest): Promise<PublishCheckViewerVersionResult>;
  verifyTarget(args: { draft: PublishTargetWriteRequest; skipNetwork?: boolean }): Promise<VerifyTargetResult>;
  start(args: PublishStartRequest): Promise<PublishStartAck>;
  cancel(args: { jobId: string }): Promise<void>;
  rollback(args: PublishRollbackRequest): Promise<void>;
  deletePublish(args: { targetId: string; publishId: string }): Promise<PublishDeleteResult>;
  onProgress(listener: (event: PublishProgressEvent) => void): () => void;
  openVercelTokens(): Promise<void>;
  verifyVercelToken(args: { token: string; teamId?: string }): Promise<VercelTokenVerifyResult>;
  saveVercelSettings(args: VercelSettingsWriteRequest): Promise<RedactedPublishSettings>;
  deployViewer(): Promise<{ jobId: string }>;
  onViewerDeployProgress(listener: (event: DeployViewerProgressEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
  /** Persist the publisher's "use this layout next time" default. Layout is a FlexLayout IJsonModel. */
  setDefaultLayout(args: { layout: unknown | null }): Promise<RedactedPublishSettings>;
  /** Persist the publisher's "use these permissions next time" default. */
  setDefaultPermissions(args: { permissions: unknown | null }): Promise<RedactedPublishSettings>;
}

export interface ElectronApi {
  mode: AppMode;
  getPathForFile(file: File): string | null;
  loadRecents(): Promise<RecentsEntry[]>;
  saveRecents(entries: RecentsEntry[]): Promise<void>;
  removeRecent(args: { uuid: string }): Promise<void>;
  locateRecent(args: { uuid: string; title?: string }): Promise<RecentsEntry | null>;
  loadDefaults(): Promise<DefaultProjectPointer | null>;
  saveDefaults(pointer: DefaultProjectPointer | null): Promise<void>;
  selectSimularcaFile(args?: { title?: string }): Promise<string | null>;
  selectFolder(args?: { title?: string; defaultPath?: string }): Promise<string | null>;
  getDefaultProjectsRoot(): Promise<string>;
  createNewProject(args: {
    parentFolder?: string;
    projectName: string;
    initialSnapshotPayload: string;
  }): Promise<ProjectIdentity>;
  openProject(args: { simularcaPath: string }): Promise<OpenProjectResult>;
  saveProjectSnapshot(args: { projectPath: string; snapshotName: string; payload: string }): Promise<void>;
  loadSnapshot(args: { projectPath: string; snapshotName: string }): Promise<string>;
  listSnapshots(args: { projectPath: string }): Promise<ProjectSnapshotListEntry[]>;
  saveProjectAs(args: {
    currentPath: string;
    newParentFolder: string;
    newProjectName: string;
  }): Promise<ProjectIdentity>;
  moveProject(args: { currentPath: string; newParentFolder: string }): Promise<ProjectIdentity>;
  renameProject(args: { currentPath: string; newProjectName: string }): Promise<ProjectIdentity>;
  deleteProject(args: { projectPath: string }): Promise<void>;
  repairProjectPointer(args: { folderPath: string }): Promise<ProjectIdentity>;
  duplicateSnapshot(args: { projectPath: string; previousName: string; nextName: string }): Promise<void>;
  renameSnapshot(args: { projectPath: string; previousName: string; nextName: string }): Promise<void>;
  deleteSnapshot(args: { projectPath: string; snapshotName: string }): Promise<void>;
  detectLegacyProjects(): Promise<LegacyProjectInfo[]>;
  migrateLegacyProject(args: { legacyName: string; targetParentFolder: string }): Promise<ProjectIdentity>;
  writeMigrationReadme(args: {
    failedProjectNames: string[];
    skippedProjectNames: string[];
  }): Promise<void>;
  deleteLegacyProject(args: { legacyName: string }): Promise<void>;
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
  readProjectionCache(args: { projectPath: string }): Promise<ProjectionCacheFileV1 | null>;
  writeProjectionCache(args: { projectPath: string; payload: ProjectionCacheFileV1 }): Promise<void>;
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
  logRuntimeStats(payload: Record<string, unknown>): void;
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
  onBeforeClose(listener: () => void): () => void;
  confirmClose(action: "save-and-quit" | "quit" | "cancel"): Promise<void>;
  publish: PublishApi;
}

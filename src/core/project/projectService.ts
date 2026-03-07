import { createInitialState } from "@/core/defaults";
import { buildProjectSnapshotManifest } from "@/core/project/projectSnapshotManifest";
import { parseProjectSnapshot, serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { AppStoreApi } from "@/core/store/appStore";
import type { DefaultProjectPointer, ProjectSnapshotListEntry } from "@/types/ipc";
import type { ProjectSnapshotManifest } from "@/core/types";

const DEFAULT_SNAPSHOT_NAME = "main";

export class ProjectService {
  public constructor(
    private readonly storage: StorageAdapter,
    private readonly store: AppStoreApi
  ) {}

  public async loadDefaultProject(): Promise<void> {
    const pointer = await this.storage.loadDefaults();
    await this.loadProject(pointer.defaultProjectName, pointer.defaultSnapshotName);
  }

  public async loadProject(projectName: string, snapshotName = DEFAULT_SNAPSHOT_NAME): Promise<void> {
    const raw = await this.storage.loadProjectSnapshot(projectName, snapshotName);
    if (raw.trim() === "{}") {
      const fresh = createInitialState(this.storage.mode, projectName, snapshotName);
      this.store.getState().actions.hydrate(fresh);
      this.store.getState().actions.setStats({
        projectFileBytes: 0,
        projectFileBytesSaved: 0
      });
      return;
    }
    const parsed = parseProjectSnapshot(raw);
    const canonicalizedManifest: ProjectSnapshotManifest =
      parsed.projectName === projectName && parsed.snapshotName === snapshotName
        ? parsed
        : { ...parsed, projectName, snapshotName };
    const manifest = canonicalizedManifest;
    const projectBytes = new Blob([raw]).size;
    this.store.getState().actions.hydrate({
      ...createInitialState(this.storage.mode, projectName, snapshotName),
      activeProjectName: projectName,
      activeSnapshotName: snapshotName,
      scene: manifest.scene,
      actors: manifest.actors,
      components: manifest.components,
      camera: manifest.camera,
      cameraBookmarks: manifest.cameraBookmarks,
      time: manifest.time,
      materials: manifest.materials,
      assets: manifest.assets,
      dirty: false
    });
    this.store.getState().actions.setStats({
      projectFileBytes: projectBytes,
      projectFileBytesSaved: projectBytes
    });
    if ((parsed.projectName !== projectName || parsed.snapshotName !== snapshotName) && !this.storage.isReadOnly) {
      await this.saveProject();
    }
  }

  public async saveProject(): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const state = this.store.getState().state;
    const payload = serializeProjectSnapshot(buildProjectSnapshotManifest(state, this.storage.mode));
    await this.storage.saveProjectSnapshot(state.activeProjectName, state.activeSnapshotName, payload);
    this.store.getState().actions.setDirty(false);
    const savedBytes = new Blob([payload]).size;
    this.store.getState().actions.setStats({
      projectFileBytes: savedBytes,
      projectFileBytesSaved: savedBytes
    });
  }

  public async saveProjectAs(projectName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const normalizedName = projectName.trim();
    if (!normalizedName) {
      throw new Error("Project name is required.");
    }
    const previousName = this.store.getState().state.activeProjectName;
    if (previousName === normalizedName) {
      await this.saveProject();
      return;
    }
    await this.saveProject();
    await this.storage.cloneProject(previousName, normalizedName);
    this.store.getState().actions.setProjectName(normalizedName);
    await this.storage.saveDefaults({
      defaultProjectName: normalizedName,
      defaultSnapshotName: this.store.getState().state.activeSnapshotName
    });
    await this.saveProject();
  }

  public async duplicateProject(sourceProjectName: string, nextProjectName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const normalizedName = nextProjectName.trim();
    if (!normalizedName) {
      throw new Error("Project name is required.");
    }
    if (sourceProjectName === normalizedName) {
      throw new Error("Duplicate project name must be different.");
    }
    await this.storage.cloneProject(sourceProjectName, normalizedName);
  }

  public async saveSnapshotAs(snapshotName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }
    const normalizedName = snapshotName.trim();
    if (!normalizedName) {
      throw new Error("Snapshot name is required.");
    }
    const state = this.store.getState().state;
    const payload = serializeProjectSnapshot(buildProjectSnapshotManifest(state, this.storage.mode));
    await this.storage.saveProjectSnapshot(state.activeProjectName, normalizedName, payload);
    this.store.getState().actions.setSnapshotName(normalizedName);
    this.store.getState().actions.setDirty(false);
    const savedBytes = new Blob([payload]).size;
    this.store.getState().actions.setStats({
      projectFileBytes: savedBytes,
      projectFileBytesSaved: savedBytes
    });
  }

  public async createNewProject(projectName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }
    const normalizedName = projectName.trim();
    if (!normalizedName) {
      throw new Error("Project name is required.");
    }
    const fresh = createInitialState(this.storage.mode, normalizedName, DEFAULT_SNAPSHOT_NAME);
    this.store.getState().actions.hydrate(fresh);
    await this.storage.saveDefaults({
      defaultProjectName: normalizedName,
      defaultSnapshotName: DEFAULT_SNAPSHOT_NAME
    });
    await this.saveProject();
  }

  public async renameProject(previousName: string, nextName: string): Promise<void> {
    const normalizedName = nextName.trim();
    if (this.storage.isReadOnly || previousName === normalizedName) {
      return;
    }
    if (!normalizedName) {
      throw new Error("Project name is required.");
    }
    const stateBeforeRename = this.store.getState().state;
    const renamingActiveProject = stateBeforeRename.activeProjectName === previousName;
    if (renamingActiveProject) {
      await this.saveProject();
    }
    await this.storage.renameProject(previousName, normalizedName);
    const state = this.store.getState().state;
    if (renamingActiveProject || state.activeProjectName === previousName) {
      this.store.getState().actions.setProjectName(normalizedName);
    }
    await this.storage.saveDefaults({
      defaultProjectName: normalizedName,
      defaultSnapshotName: this.store.getState().state.activeSnapshotName
    });
    if (renamingActiveProject) {
      await this.saveProject();
    }
  }

  public async deleteProject(projectName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const projects = await this.storage.listProjects();
    if (projects.length <= 1) {
      throw new Error("Cannot delete the last remaining project.");
    }

    const state = this.store.getState().state;
    const defaults = await this.storage.loadDefaults();
    const deletingActiveProject = state.activeProjectName === projectName;
    const deletingDefaultProject = defaults.defaultProjectName === projectName;
    const remainingProjects = projects.filter((entry) => entry !== projectName);
    const fallbackProjectName = deletingActiveProject ? remainingProjects[0] : state.activeProjectName;
    if (!fallbackProjectName) {
      throw new Error("No fallback project is available.");
    }

    await this.storage.deleteProject(projectName);

    if (deletingActiveProject) {
      const fallbackSnapshotName = await this.resolvePreferredSnapshotName(fallbackProjectName);
      await this.loadProject(fallbackProjectName, fallbackSnapshotName);
      if (deletingDefaultProject) {
        await this.storage.saveDefaults({
          defaultProjectName: fallbackProjectName,
          defaultSnapshotName: fallbackSnapshotName
        });
      }
      return;
    }

    if (deletingDefaultProject) {
      await this.storage.saveDefaults({
        defaultProjectName: state.activeProjectName,
        defaultSnapshotName: state.activeSnapshotName
      });
    }
  }

  public async duplicateSnapshot(previousName: string, nextName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }
    const state = this.store.getState().state;
    await this.storage.duplicateSnapshot(state.activeProjectName, previousName, nextName);
  }

  public async renameSnapshot(previousName: string, nextName: string): Promise<void> {
    const normalizedName = nextName.trim();
    if (this.storage.isReadOnly || previousName === normalizedName) {
      return;
    }
    if (!normalizedName) {
      throw new Error("Snapshot name is required.");
    }
    const state = this.store.getState().state;
    await this.storage.renameSnapshot(state.activeProjectName, previousName, normalizedName);
    if (state.activeSnapshotName === previousName) {
      this.store.getState().actions.setSnapshotName(normalizedName);
    }
    await this.saveDefaultsForCurrentState();
  }

  public async deleteSnapshot(snapshotName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }
    const state = this.store.getState().state;
    const snapshots = await this.storage.listSnapshots(state.activeProjectName);
    if (snapshots.length <= 1) {
      throw new Error("Cannot delete the last remaining snapshot.");
    }
    await this.storage.deleteSnapshot(state.activeProjectName, snapshotName);
    if (state.activeSnapshotName === snapshotName) {
      const remaining = snapshots.filter((entry) => entry.name !== snapshotName);
      const nextSnapshot = remaining[0]?.name ?? DEFAULT_SNAPSHOT_NAME;
      await this.loadProject(state.activeProjectName, nextSnapshot);
    }
    await this.saveDefaultsForCurrentState();
  }

  public async setDefaultProject(): Promise<void> {
    await this.saveDefaultsForCurrentState();
  }

  public async setDefaultSnapshot(snapshotName?: string, projectName?: string): Promise<void> {
    const state = this.store.getState().state;
    await this.storage.saveDefaults({
      defaultProjectName: projectName ?? state.activeProjectName,
      defaultSnapshotName: snapshotName ?? state.activeSnapshotName
    });
  }

  public queueAutosave(delayMs = 1000): void {
    // Intentionally disabled: project persistence is manual-only.
    void delayMs;
  }

  public async listProjects(): Promise<string[]> {
    return this.storage.listProjects();
  }

  public async listSnapshots(projectName?: string): Promise<ProjectSnapshotListEntry[]> {
    return this.storage.listSnapshots(projectName ?? this.store.getState().state.activeProjectName);
  }

  public async loadDefaultsPointer(): Promise<DefaultProjectPointer> {
    return this.storage.loadDefaults();
  }

  public get isReadOnly(): boolean {
    return this.storage.isReadOnly;
  }
  private async saveDefaultsForCurrentState(): Promise<void> {
    const state = this.store.getState().state;
    await this.storage.saveDefaults({
      defaultProjectName: state.activeProjectName,
      defaultSnapshotName: state.activeSnapshotName
    });
  }

  private async resolvePreferredSnapshotName(projectName: string): Promise<string> {
    const snapshots = await this.storage.listSnapshots(projectName);
    const mainSnapshot = snapshots.find((entry) => entry.name === DEFAULT_SNAPSHOT_NAME);
    return mainSnapshot?.name ?? snapshots[0]?.name ?? DEFAULT_SNAPSHOT_NAME;
  }
}

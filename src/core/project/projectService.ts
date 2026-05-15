import { createInitialState } from "@/core/defaults";
import { buildProjectSnapshotManifest } from "@/core/project/projectSnapshotManifest";
import { parseProjectSnapshot, serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import {
  clearAllProjectedPolylines,
  flushProjectionCacheNow,
  hydrateProjectionCacheFromFile
} from "@/features/curves/projectionCache";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { AppStoreApi } from "@/core/store/appStore";
import type {
  DefaultProjectPointer,
  ProjectIdentity,
  ProjectSnapshotListEntry,
  RecentsEntry
} from "@/types/ipc";
import type { ProjectSnapshotManifest } from "@/core/types";

const DEFAULT_SNAPSHOT_NAME = "main";
const MAX_RECENTS = 20;

export class ProjectService {
  public constructor(
    private readonly storage: StorageAdapter,
    private readonly store: AppStoreApi
  ) {}

  /**
   * On startup, try the last default; if it fails, fall through to the next
   * resolvable recents entry. Leave activeProject = null (welcome screen) if
   * nothing resolves.
   */
  public async loadDefaultProject(): Promise<void> {
    const defaults = await this.storage.loadDefaults();
    const recents = await this.storage.loadRecents();
    const candidates: { path: string; lastSnapshotName: string | null }[] = [];
    if (defaults) {
      candidates.push({ path: defaults.path, lastSnapshotName: defaults.lastSnapshotName });
    }
    for (const entry of recents) {
      if (defaults && entry.path === defaults.path) continue;
      candidates.push({ path: entry.path, lastSnapshotName: entry.lastSnapshotName });
    }
    for (const candidate of candidates) {
      try {
        await this.openProject(candidate.path, candidate.lastSnapshotName);
        return;
      } catch {
        // Try the next one.
      }
    }
    // Nothing resolved — welcome screen.
    this.store.getState().actions.setActiveProject(null);
  }

  public async openProject(simularcaPath: string, requestedSnapshotName: string | null = null): Promise<void> {
    const result = await this.storage.openProject(simularcaPath);
    const snapshotName = pickSnapshotName(result.snapshots, requestedSnapshotName ?? result.lastSnapshotName);
    await this.hydrateFromStorage(result.identity, snapshotName);
    await this.promoteAndSetDefault(result.identity, snapshotName);
  }

  public async createNewProject(args: { parentFolder?: string; projectName: string }): Promise<void> {
    if (this.storage.isReadOnly) return;
    const trimmed = args.projectName.trim();
    if (!trimmed) {
      throw new Error("Project name is required.");
    }
    const placeholderState = createInitialState(this.storage.mode, null, DEFAULT_SNAPSHOT_NAME);
    const initialPayload = serializeProjectSnapshot(
      buildProjectSnapshotManifest(
        { ...placeholderState, activeSnapshotName: DEFAULT_SNAPSHOT_NAME },
        this.storage.mode,
        { projectName: trimmed }
      )
    );
    const identity = await this.storage.createNewProject({
      parentFolder: args.parentFolder,
      projectName: trimmed,
      initialSnapshotPayload: initialPayload
    });
    await this.hydrateFromStorage(identity, DEFAULT_SNAPSHOT_NAME);
    await this.promoteAndSetDefault(identity, DEFAULT_SNAPSHOT_NAME);
  }

  public async saveProject(): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    const payload = serializeProjectSnapshot(
      buildProjectSnapshotManifest(state, this.storage.mode, { projectName: state.activeProject.name })
    );
    await this.storage.saveSnapshot(state.activeProject.path, state.activeSnapshotName, payload);
    await flushProjectionCacheNow();
    this.store.getState().actions.setDirty(false);
    const savedBytes = new Blob([payload]).size;
    this.store.getState().actions.setStats({
      projectFileBytes: savedBytes,
      projectFileBytesSaved: savedBytes
    });
    await this.promoteAndSetDefault(state.activeProject, state.activeSnapshotName);
  }

  public async saveProjectAs(args: { newParentFolder: string; newProjectName: string }): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) {
      throw new Error("No active project to save.");
    }
    await this.saveProject();
    const identity = await this.storage.saveProjectAs({
      currentPath: state.activeProject.path,
      newParentFolder: args.newParentFolder,
      newProjectName: args.newProjectName
    });
    this.store.getState().actions.setActiveProject(identity);
    await this.saveProject();
    await this.promoteAndSetDefault(identity, this.store.getState().state.activeSnapshotName);
  }

  public async moveProject(newParentFolder: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    await this.saveProject();
    const identity = await this.storage.moveProject({
      currentPath: state.activeProject.path,
      newParentFolder
    });
    this.store.getState().actions.setActiveProject(identity);
    // Move keeps the same uuid; update the recents entry path in place.
    const recents = await this.storage.loadRecents();
    const next = recents.map((entry) =>
      entry.uuid === identity.uuid
        ? { ...entry, path: identity.path, cachedName: identity.name }
        : entry
    );
    await this.storage.saveRecents(next);
    await this.storage.saveDefaults({
      uuid: identity.uuid,
      path: identity.path,
      lastSnapshotName: state.activeSnapshotName
    });
  }

  public async renameProject(newProjectName: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    const trimmed = newProjectName.trim();
    if (!trimmed || trimmed === state.activeProject.name) return;
    await this.saveProject();
    const identity = await this.storage.renameProject({
      currentPath: state.activeProject.path,
      newProjectName: trimmed
    });
    this.store.getState().actions.setActiveProject(identity);
    const recents = await this.storage.loadRecents();
    const next = recents.map((entry) =>
      entry.uuid === identity.uuid
        ? { ...entry, path: identity.path, cachedName: identity.name }
        : entry
    );
    await this.storage.saveRecents(next);
    await this.storage.saveDefaults({
      uuid: identity.uuid,
      path: identity.path,
      lastSnapshotName: state.activeSnapshotName
    });
  }

  public async deleteProject(projectPath: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    const recents = await this.storage.loadRecents();
    const target = recents.find((entry) => entry.path === projectPath) ?? null;
    const isActive = state.activeProject?.path === projectPath;
    await this.storage.deleteProject(projectPath);

    if (isActive) {
      // Try to fall through to the next valid recent that isn't the deleted one.
      const remaining = recents.filter((entry) => entry.path !== projectPath);
      let opened = false;
      for (const entry of remaining) {
        try {
          await this.openProject(entry.path, entry.lastSnapshotName);
          opened = true;
          break;
        } catch {
          // Try the next.
        }
      }
      if (!opened) {
        this.store.getState().actions.setActiveProject(null);
      }
    } else if (target) {
      // Inactive deletion — just trim recents.
      const next = recents.filter((entry) => entry.uuid !== target.uuid);
      await this.storage.saveRecents(next);
    }
  }

  public async loadSnapshot(snapshotName: string): Promise<void> {
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    await this.hydrateFromStorage(state.activeProject, snapshotName);
    await this.promoteAndSetDefault(state.activeProject, snapshotName);
  }

  public async saveSnapshotAs(snapshotName: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const trimmed = snapshotName.trim();
    if (!trimmed) {
      throw new Error("Snapshot name is required.");
    }
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    const payload = serializeProjectSnapshot(
      buildProjectSnapshotManifest(state, this.storage.mode, { projectName: state.activeProject.name })
    );
    await this.storage.saveSnapshot(state.activeProject.path, trimmed, payload);
    this.store.getState().actions.setSnapshotName(trimmed);
    this.store.getState().actions.setDirty(false);
    const savedBytes = new Blob([payload]).size;
    this.store.getState().actions.setStats({
      projectFileBytes: savedBytes,
      projectFileBytesSaved: savedBytes
    });
    await this.promoteAndSetDefault(state.activeProject, trimmed);
  }

  public async duplicateSnapshot(previousName: string, nextName: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    await this.storage.duplicateSnapshot(state.activeProject.path, previousName, nextName);
  }

  public async renameSnapshot(previousName: string, nextName: string): Promise<void> {
    const trimmed = nextName.trim();
    if (this.storage.isReadOnly || previousName === trimmed) return;
    if (!trimmed) {
      throw new Error("Snapshot name is required.");
    }
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    await this.storage.renameSnapshot(state.activeProject.path, previousName, trimmed);
    if (state.activeSnapshotName === previousName) {
      this.store.getState().actions.setSnapshotName(trimmed);
      await this.promoteAndSetDefault(state.activeProject, trimmed);
    }
  }

  public async deleteSnapshot(snapshotName: string): Promise<void> {
    if (this.storage.isReadOnly) return;
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    const snapshots = await this.storage.listSnapshots(state.activeProject.path);
    if (snapshots.length <= 1) {
      throw new Error("Cannot delete the last remaining snapshot.");
    }
    await this.storage.deleteSnapshot(state.activeProject.path, snapshotName);
    if (state.activeSnapshotName === snapshotName) {
      const remaining = snapshots.filter((entry) => entry.name !== snapshotName);
      const nextSnapshot = remaining[0]?.name ?? DEFAULT_SNAPSHOT_NAME;
      await this.hydrateFromStorage(state.activeProject, nextSnapshot);
      await this.promoteAndSetDefault(state.activeProject, nextSnapshot);
    }
  }

  public async setDefaultProject(): Promise<void> {
    const state = this.store.getState().state;
    if (!state.activeProject) return;
    await this.promoteAndSetDefault(state.activeProject, state.activeSnapshotName);
  }

  public async listSnapshots(projectPath?: string): Promise<ProjectSnapshotListEntry[]> {
    const state = this.store.getState().state;
    const target = projectPath ?? state.activeProject?.path;
    if (!target) return [];
    return this.storage.listSnapshots(target);
  }

  public async loadRecents(): Promise<RecentsEntry[]> {
    return this.storage.loadRecents();
  }

  public async loadDefaults(): Promise<DefaultProjectPointer | null> {
    return this.storage.loadDefaults();
  }

  public queueAutosave(delayMs = 1000): void {
    void delayMs;
  }

  public get isReadOnly(): boolean {
    return this.storage.isReadOnly;
  }

  private async hydrateFromStorage(identity: ProjectIdentity, snapshotName: string): Promise<void> {
    // Reset the projection cache before swapping projects so one project's polylines
    // never bleed into another.
    clearAllProjectedPolylines();
    const cacheFile = await this.storage.readProjectionCache(identity.path).catch(() => null);
    hydrateProjectionCacheFromFile(cacheFile);
    const raw = await this.storage.loadSnapshot(identity.path, snapshotName);
    if (raw.trim() === "{}") {
      const fresh = createInitialState(this.storage.mode, identity, snapshotName);
      this.store.getState().actions.hydrate(fresh);
      this.store.getState().actions.setStats({
        projectFileBytes: 0,
        projectFileBytesSaved: 0
      });
      return;
    }
    const parsed = parseProjectSnapshot(raw);
    const canonicalized: ProjectSnapshotManifest =
      parsed.projectName === identity.name && parsed.snapshotName === snapshotName
        ? parsed
        : { ...parsed, projectName: identity.name, snapshotName };
    const projectBytes = new Blob([raw]).size;
    this.store.getState().actions.hydrate({
      ...createInitialState(this.storage.mode, identity, snapshotName),
      activeProject: identity,
      activeSnapshotName: snapshotName,
      scene: canonicalized.scene,
      actors: canonicalized.actors,
      components: canonicalized.components,
      camera: canonicalized.camera,
      time: canonicalized.time,
      pluginViews: canonicalized.pluginViews,
      pluginsEnabled: canonicalized.pluginsEnabled,
      materials: canonicalized.materials,
      assets: canonicalized.assets,
      dirty: false
    });
    this.store.getState().actions.setStats({
      projectFileBytes: projectBytes,
      projectFileBytesSaved: projectBytes
    });
    if ((parsed.projectName !== identity.name || parsed.snapshotName !== snapshotName) && !this.storage.isReadOnly) {
      await this.saveProject();
    }
  }

  private async promoteAndSetDefault(identity: ProjectIdentity, snapshotName: string): Promise<void> {
    const recents = await this.storage.loadRecents();
    const now = new Date().toISOString();
    const next: RecentsEntry = {
      uuid: identity.uuid,
      path: identity.path,
      cachedName: identity.name,
      lastOpenedAtIso: now,
      lastSnapshotName: snapshotName
    };
    const filtered = recents.filter((entry) => entry.uuid !== identity.uuid);
    const updated = [next, ...filtered].slice(0, MAX_RECENTS);
    await this.storage.saveRecents(updated);
    await this.storage.saveDefaults({
      uuid: identity.uuid,
      path: identity.path,
      lastSnapshotName: snapshotName
    });
  }
}

function pickSnapshotName(
  available: ProjectSnapshotListEntry[],
  requested: string | null
): string {
  if (requested && available.some((s) => s.name === requested)) {
    return requested;
  }
  if (available.some((s) => s.name === DEFAULT_SNAPSHOT_NAME)) {
    return DEFAULT_SNAPSHOT_NAME;
  }
  return available[0]?.name ?? DEFAULT_SNAPSHOT_NAME;
}

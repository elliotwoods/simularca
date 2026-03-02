import { createInitialState } from "@/core/defaults";
import { parseSession, serializeSession } from "@/core/session/sessionSchema";
import { SESSION_SCHEMA_VERSION, type SessionManifest } from "@/core/types";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { AppStore, AppStoreApi } from "@/core/store/appStore";

function toManifest(state: AppStore["state"], mode: SessionManifest["appMode"]): SessionManifest {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    appMode: mode,
    sessionName: state.activeSessionName,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    scene: structuredClone(state.scene),
    actors: structuredClone(state.actors),
    components: structuredClone(state.components),
    camera: structuredClone(state.camera),
    cameraBookmarks: structuredClone(state.cameraBookmarks),
    time: structuredClone(state.time),
    assets: structuredClone(state.assets)
  };
}

export class SessionService {
  public constructor(
    private readonly storage: StorageAdapter,
    private readonly store: AppStoreApi
  ) {}

  public async loadDefaultSession(): Promise<void> {
    const pointer = await this.storage.loadDefaults();
    await this.loadSession(pointer.defaultSessionName);
  }

  public async loadSession(sessionName: string): Promise<void> {
    const raw = await this.storage.loadSession(sessionName);
    if (raw.trim() === "{}") {
      const fresh = createInitialState(this.storage.mode, sessionName);
      this.store.getState().actions.hydrate(fresh);
      return;
    }
    const manifest = parseSession(raw);
    this.store.getState().actions.hydrate({
      ...createInitialState(this.storage.mode, sessionName),
      activeSessionName: manifest.sessionName,
      scene: manifest.scene,
      actors: manifest.actors,
      components: manifest.components,
      camera: manifest.camera,
      cameraBookmarks: manifest.cameraBookmarks,
      time: manifest.time,
      assets: manifest.assets,
      dirty: false
    });
  }

  public async saveSession(): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const state = this.store.getState().state;
    const payload = serializeSession(toManifest(state, this.storage.mode));
    await this.storage.saveSession(state.activeSessionName, payload);
    this.store.getState().actions.setDirty(false);
    this.store.getState().actions.setStats({ sessionFileBytes: new Blob([payload]).size });
  }

  public async saveAs(sessionName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    this.store.getState().actions.setSessionName(sessionName);
    await this.storage.saveDefaults({ defaultSessionName: sessionName });
    await this.saveSession();
  }

  public async createNewSession(sessionName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const fresh = createInitialState(this.storage.mode, sessionName);
    this.store.getState().actions.hydrate(fresh);
    await this.storage.saveDefaults({ defaultSessionName: sessionName });
    await this.saveSession();
  }

  public async renameSession(previousName: string, nextName: string): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }
    if (previousName === nextName) {
      return;
    }
    await this.storage.renameSession(previousName, nextName);
    const state = this.store.getState().state;
    if (state.activeSessionName === previousName) {
      this.store.getState().actions.setSessionName(nextName);
      this.store.getState().actions.setDirty(false);
    }
    await this.storage.saveDefaults({ defaultSessionName: nextName });
  }

  public queueAutosave(delayMs = 1000): void {
    // Intentionally disabled: session persistence is manual-only (Save / Ctrl+S).
    void delayMs;
  }

  public async listSessions(): Promise<string[]> {
    return this.storage.listSessions();
  }

  public get isReadOnly(): boolean {
    return this.storage.isReadOnly;
  }
}

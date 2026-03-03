import { createInitialState } from "@/core/defaults";
import { buildSessionManifest } from "@/core/session/sessionManifest";
import { parseSession, serializeSession } from "@/core/session/sessionSchema";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { AppStoreApi } from "@/core/store/appStore";

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
      this.store.getState().actions.setStats({
        sessionFileBytes: 0,
        sessionFileBytesSaved: 0
      });
      return;
    }
    const manifest = parseSession(raw);
    const sessionBytes = new Blob([raw]).size;
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
    this.store.getState().actions.setStats({
      sessionFileBytes: sessionBytes,
      sessionFileBytesSaved: sessionBytes
    });
  }

  public async saveSession(): Promise<void> {
    if (this.storage.isReadOnly) {
      return;
    }

    const state = this.store.getState().state;
    const payload = serializeSession(buildSessionManifest(state, this.storage.mode));
    await this.storage.saveSession(state.activeSessionName, payload);
    this.store.getState().actions.setDirty(false);
    const savedBytes = new Blob([payload]).size;
    this.store.getState().actions.setStats({
      sessionFileBytes: savedBytes,
      sessionFileBytesSaved: savedBytes
    });
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

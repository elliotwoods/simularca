import { createInitialState } from "@/core/defaults";
import { buildSessionManifest } from "@/core/session/sessionManifest";
import { parseSession, serializeSession } from "@/core/session/sessionSchema";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { AppStoreApi } from "@/core/store/appStore";
import type { SessionAssetRef } from "@/types/ipc";
import type { SessionManifest } from "@/core/types";

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
    const parsed = parseSession(raw);
    const canonicalizedManifest: SessionManifest =
      parsed.sessionName === sessionName ? parsed : { ...parsed, sessionName };
    const migrated = await this.migrateLegacyGaussianAssets(canonicalizedManifest);
    const manifest = migrated.manifest;
    const sessionBytes = new Blob([raw]).size;
    this.store.getState().actions.hydrate({
      ...createInitialState(this.storage.mode, sessionName),
      activeSessionName: sessionName,
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
    if ((migrated.changed || parsed.sessionName !== sessionName) && !this.storage.isReadOnly) {
      await this.saveSession();
      if (migrated.changed) {
        this.store.getState().actions.setStatus("Converted legacy Gaussian assets to native splat binary.");
      }
    }
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

    const previousName = this.store.getState().state.activeSessionName;
    if (previousName === sessionName) {
      await this.saveSession();
      return;
    }
    // Persist current state before cloning to ensure session.json and assets are coherent.
    await this.saveSession();
    await this.storage.cloneSession(previousName, sessionName);
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
    const stateBeforeRename = this.store.getState().state;
    const renamingActiveSession = stateBeforeRename.activeSessionName === previousName;
    if (renamingActiveSession) {
      await this.saveSession();
    }
    await this.storage.renameSession(previousName, nextName);
    const state = this.store.getState().state;
    if (renamingActiveSession || state.activeSessionName === previousName) {
      this.store.getState().actions.setSessionName(nextName);
    }
    await this.storage.saveDefaults({ defaultSessionName: nextName });
    if (renamingActiveSession) {
      await this.saveSession();
    }
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

  private async migrateLegacyGaussianAssets(
    manifest: SessionManifest
  ): Promise<{ manifest: SessionManifest; changed: boolean }> {
    if (this.storage.isReadOnly) {
      return { manifest, changed: false };
    }
    let changed = false;
    const nextAssets: SessionAssetRef[] = [];
    for (const asset of manifest.assets) {
      const isGaussian = asset.kind === "gaussian-splat";
      const alreadyNative = asset.encoding === "splatbin-v1" || asset.relativePath.toLowerCase().endsWith(".splatbin");
      if (!isGaussian || alreadyNative) {
        nextAssets.push(asset);
        continue;
      }
      const converted = await this.storage.convertGaussianAsset({
        sessionName: manifest.sessionName,
        assetId: asset.id,
        relativePath: asset.relativePath,
        sourceFileName: asset.sourceFileName
      });
      nextAssets.push(converted);
      changed = true;
    }
    return {
      manifest: changed ? { ...manifest, assets: nextAssets } : manifest,
      changed
    };
  }
}

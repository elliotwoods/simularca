import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "@/core/defaults";
import { createAppStore } from "@/core/store/appStore";
import { SessionService } from "@/core/session/sessionService";
import { serializeSession, parseSession } from "@/core/session/sessionSchema";
import { SESSION_SCHEMA_VERSION, type SessionManifest } from "@/core/types";
import type { StorageAdapter } from "@/features/storage/storageAdapter";
import type { SessionAssetRef } from "@/types/ipc";

function buildManifest(sessionName: string, assets: SessionAssetRef[] = []): SessionManifest {
  const state = createInitialState("electron-rw", sessionName);
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    appMode: "electron-rw",
    sessionName,
    createdAtIso: "2026-03-03T00:00:00.000Z",
    updatedAtIso: "2026-03-03T00:00:00.000Z",
    scene: state.scene,
    actors: state.actors,
    components: state.components,
    camera: state.camera,
    cameraBookmarks: state.cameraBookmarks,
    time: state.time,
    materials: state.materials,
    assets
  };
}

function createStorageMocks(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    mode: "electron-rw",
    isReadOnly: false,
    listSessions: vi.fn(async () => ["demo"]),
    loadDefaults: vi.fn(async () => ({ defaultSessionName: "demo" })),
    saveDefaults: vi.fn(async () => {}),
    loadSession: vi.fn(async () => "{}"),
    saveSession: vi.fn(async () => {}),
    cloneSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    importAsset: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    importGaussianSplat: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    convertGaussianAsset: vi.fn(
      async (args: { sessionName: string; assetId: string; relativePath: string; sourceFileName: string }) =>
        ({
          id: args.assetId,
          kind: "gaussian-splat",
          encoding: "splatbin-v1",
          relativePath: "assets/gaussian-splat/converted.splatbin",
          sourceFileName: args.sourceFileName,
          byteSize: 1024
        }) satisfies SessionAssetRef
    ),
    transcodeHdriToKtx2: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    deleteAsset: vi.fn(async () => {}),
    resolveAssetPath: vi.fn(async ({ sessionName, relativePath }) => `/sessions/${sessionName}/${relativePath}`),
    readAssetBytes: vi.fn(async () => new Uint8Array()),
    ...overrides
  };
}

describe("session service", () => {
  it("uses requested session name as canonical identity and repairs stale manifest name", async () => {
    const storage = createStorageMocks({
      loadSession: vi.fn(async () => serializeSession(buildManifest("old-name")))
    });
    const store = createAppStore("electron-rw");
    const service = new SessionService(storage, store);

    await service.loadSession("new-name");

    expect(store.getState().state.activeSessionName).toBe("new-name");
    expect(storage.saveSession).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(storage.saveSession).mock.calls[0];
    expect(saved?.[0]).toBe("new-name");
    const payload = saved?.[1] ?? "";
    expect(parseSession(payload).sessionName).toBe("new-name");
  });

  it("runs gaussian asset migration against canonical requested session name", async () => {
    const legacyAsset: SessionAssetRef = {
      id: "legacy-asset-1",
      kind: "gaussian-splat",
      encoding: "raw",
      relativePath: "assets/gaussian-splat/legacy.ply",
      sourceFileName: "legacy.ply",
      byteSize: 42
    };
    const storage = createStorageMocks({
      loadSession: vi.fn(async () => serializeSession(buildManifest("old-name", [legacyAsset])))
    });
    const store = createAppStore("electron-rw");
    const service = new SessionService(storage, store);

    await service.loadSession("new-name");

    expect(storage.convertGaussianAsset).toHaveBeenCalledTimes(1);
    const args = vi.mocked(storage.convertGaussianAsset).mock.calls[0]?.[0];
    expect(args?.sessionName).toBe("new-name");
  });

  it("auto-saves before and after active-session rename", async () => {
    const events: string[] = [];
    const storage = createStorageMocks({
      saveSession: vi.fn(async (sessionName: string) => {
        events.push(`save:${sessionName}`);
      }),
      renameSession: vi.fn(async (previousName: string, nextName: string) => {
        events.push(`rename:${previousName}->${nextName}`);
      }),
      saveDefaults: vi.fn(async ({ defaultSessionName }) => {
        events.push(`defaults:${defaultSessionName}`);
      })
    });
    const store = createAppStore("electron-rw");
    store.getState().actions.setDirty(true);
    const service = new SessionService(storage, store);

    await service.renameSession("demo", "renamed");

    expect(events).toEqual(["save:demo", "rename:demo->renamed", "defaults:renamed", "save:renamed"]);
    expect(store.getState().state.activeSessionName).toBe("renamed");
    expect(store.getState().state.dirty).toBe(false);
  });

  it("skips writes on no-op rename", async () => {
    const storage = createStorageMocks();
    const store = createAppStore("electron-rw");
    const service = new SessionService(storage, store);

    await service.renameSession("demo", "demo");

    expect(storage.renameSession).not.toHaveBeenCalled();
    expect(storage.saveDefaults).not.toHaveBeenCalled();
    expect(storage.saveSession).not.toHaveBeenCalled();
  });

  it("does not rewrite session file when manifest session name already matches and no migration happens", async () => {
    const storage = createStorageMocks({
      loadSession: vi.fn(async () => serializeSession(buildManifest("demo")))
    });
    const store = createAppStore("electron-rw");
    const service = new SessionService(storage, store);

    await service.loadSession("demo");

    expect(storage.saveSession).not.toHaveBeenCalled();
    expect(storage.convertGaussianAsset).not.toHaveBeenCalled();
  });
});

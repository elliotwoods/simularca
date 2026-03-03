import { SESSION_SCHEMA_VERSION, type AppState, type SessionManifest } from "@/core/types";

export function buildSessionManifest(state: AppState, mode: SessionManifest["appMode"]): SessionManifest {
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

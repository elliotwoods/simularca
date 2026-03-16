import { PROJECT_SCHEMA_VERSION, type AppState, type ProjectSnapshotManifest } from "@/core/types";

export function buildProjectSnapshotManifest(
  state: AppState,
  mode: ProjectSnapshotManifest["appMode"]
): ProjectSnapshotManifest {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appMode: mode,
    projectName: state.activeProjectName,
    snapshotName: state.activeSnapshotName,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    scene: structuredClone(state.scene),
    actors: structuredClone(state.actors),
    components: structuredClone(state.components),
    camera: structuredClone(state.camera),
    time: structuredClone(state.time),
    materials: structuredClone(state.materials),
    assets: structuredClone(state.assets)
  };
}

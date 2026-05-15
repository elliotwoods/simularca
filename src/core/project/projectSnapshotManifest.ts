import { PROJECT_SCHEMA_VERSION, type AppState, type ProjectSnapshotManifest } from "@/core/types";

export function buildProjectSnapshotManifest(
  state: AppState,
  mode: ProjectSnapshotManifest["appMode"],
  options: { projectName?: string } = {}
): ProjectSnapshotManifest {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appMode: mode,
    projectName: options.projectName ?? state.activeProject?.name ?? "untitled",
    snapshotName: state.activeSnapshotName,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    scene: structuredClone(state.scene),
    actors: structuredClone(state.actors),
    components: structuredClone(state.components),
    camera: structuredClone(state.camera),
    lastPerspectiveCamera: structuredClone(state.lastPerspectiveCamera),
    time: structuredClone(state.time),
    pluginViews: structuredClone(state.pluginViews),
    pluginsEnabled: structuredClone(state.pluginsEnabled),
    materials: structuredClone(state.materials),
    assets: structuredClone(state.assets)
  };
}

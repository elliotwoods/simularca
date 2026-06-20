import { PROJECT_SCHEMA_VERSION, type AppState, type ProjectSnapshotManifest } from "@/core/types";
import { stripGeneratedActors } from "@/core/scene/stripGeneratedActors";

export function buildProjectSnapshotManifest(
  state: AppState,
  mode: ProjectSnapshotManifest["appMode"],
  options: { projectName?: string } = {}
): ProjectSnapshotManifest {
  const nowIso = new Date().toISOString();
  // Generated Array-instance actors are derived state — never persist them.
  const { actors, scene } = stripGeneratedActors(state.actors, state.scene);
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appMode: mode,
    projectName: options.projectName ?? state.activeProject?.name ?? "untitled",
    snapshotName: state.activeSnapshotName,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    scene: structuredClone(scene),
    actors: structuredClone(actors),
    components: structuredClone(state.components),
    camera: structuredClone(state.camera),
    lastPerspectiveCamera: structuredClone(state.lastPerspectiveCamera),
    time: structuredClone(state.time),
    pluginViews: structuredClone(state.pluginViews),
    pluginsEnabled: structuredClone(state.pluginsEnabled),
    materials: structuredClone(state.materials),
    assets: structuredClone(state.assets),
    toolbarVisibility: structuredClone(state.toolbarVisibility)
  };
}

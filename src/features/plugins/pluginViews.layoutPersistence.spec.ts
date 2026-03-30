import { describe, expect, it } from "vitest";
import { buildProjectSnapshotManifest } from "@/core/project/projectSnapshotManifest";
import { parseProjectSnapshot, serializeProjectSnapshot } from "@/core/project/projectSnapshotSchema";
import { createAppStore } from "@/core/store/appStore";

describe("pluginViews layout persistence", () => {
  it("serializes and restores plugin views with their preferred tabset ids", () => {
    const store = createAppStore("electron-rw");
    const actorId = store.getState().actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.fake.actor",
      name: "Fake Actor"
    });
    const view = store.getState().actions.openPluginView({
      pluginId: "plugin.fake",
      actorId,
      viewType: "mylar.plots",
      title: "Plots",
      preferredTabsetId: "panel.right"
    });
    store.getState().actions.setPluginViewTabset(view.id, "panel.center");

    const payload = serializeProjectSnapshot(buildProjectSnapshotManifest(store.getState().state, "electron-rw"));
    const parsed = parseProjectSnapshot(payload);

    expect(parsed.pluginViews[view.id]).toEqual({
      ...view,
      preferredTabsetId: "panel.center"
    });
  });
});

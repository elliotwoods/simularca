import { describe, expect, it } from "vitest";
import { createAppStore } from "@/core/store/appStore";
import { createPluginViewInstanceId } from "@/features/plugins/pluginViews";

describe("pluginViews lifecycle", () => {
  it("opens the same actor-linked plugin view once and focuses the existing instance", () => {
    const store = createAppStore("electron-rw");
    const actorId = store.getState().actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.fake.actor",
      name: "Fake Actor"
    });

    const first = store.getState().actions.openPluginView({
      pluginId: "plugin.fake",
      actorId,
      viewType: "mylar.crossSection",
      title: "Cross-Section"
    });
    const second = store.getState().actions.openPluginView({
      pluginId: "plugin.fake",
      actorId,
      viewType: "mylar.crossSection",
      title: "Cross-Section"
    });

    expect(first.id).toBe(second.id);
    expect(Object.keys(store.getState().state.pluginViews)).toHaveLength(1);
    expect(store.getState().state.focusedPluginViewId).toBe(first.id);
  });

  it("closing a view leaves the actor alive and reopening reuses the same actor-linked identity", () => {
    const store = createAppStore("electron-rw");
    const actorId = store.getState().actions.createActor({
      actorType: "plugin",
      pluginType: "plugin.fake.actor",
      name: "Fake Actor"
    });
    const viewId = createPluginViewInstanceId("plugin.fake", actorId, "mylar.sweep");

    store.getState().actions.openPluginView({
      pluginId: "plugin.fake",
      actorId,
      viewType: "mylar.sweep",
      title: "Sweep"
    });
    store.getState().actions.closePluginView(viewId);

    expect(store.getState().state.actors[actorId]).toBeTruthy();
    expect(store.getState().state.pluginViews[viewId]?.open).toBe(false);

    const reopened = store.getState().actions.openPluginView({
      pluginId: "plugin.fake",
      actorId,
      viewType: "mylar.sweep",
      title: "Sweep"
    });

    expect(reopened.id).toBe(viewId);
    expect(store.getState().state.pluginViews[viewId]?.open).toBe(true);
  });
});

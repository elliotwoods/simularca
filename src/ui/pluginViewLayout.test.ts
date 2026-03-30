import { Model } from "flexlayout-react";
import { describe, expect, it } from "vitest";
import type { PluginViewState } from "@/core/types";
import { focusPluginViewTab, listPluginViewTabs, syncPluginViewTabs } from "@/ui/pluginViewLayout";

function createModel(): Model {
  return Model.fromJson({
    global: {},
    layout: {
      type: "row",
      children: [
        {
          type: "tabset",
          id: "panel.center",
          children: [
            {
              type: "tab",
              id: "tab.viewport",
              component: "center",
              name: "Viewport"
            }
          ]
        }
      ]
    }
  });
}

function createView(): PluginViewState {
  return {
    id: "plugin-view:plugin.fake:actor_1:mylar.crossSection",
    pluginId: "plugin.fake",
    actorId: "actor_1",
    viewType: "mylar.crossSection",
    tabId: "tab.plugin-view:plugin.fake:actor_1:mylar.crossSection",
    title: "Cross-Section",
    open: true,
    preferredTabsetId: "panel.center"
  };
}

describe("pluginViewLayout", () => {
  it("adds and removes plugin tabs from the workspace layout model", () => {
    const model = createModel();
    const view = createView();

    syncPluginViewTabs(model, [view], "panel.center");
    expect(listPluginViewTabs(model)).toHaveLength(1);

    syncPluginViewTabs(model, [], "panel.center");
    expect(listPluginViewTabs(model)).toHaveLength(0);
  });

  it("focuses an existing plugin tab without duplicating it", () => {
    const model = createModel();
    const view = createView();
    syncPluginViewTabs(model, [view], "panel.center");

    focusPluginViewTab(model, view.id);

    const pluginTab = listPluginViewTabs(model)[0];
    expect(pluginTab?.viewId).toBe(view.id);
  });
});

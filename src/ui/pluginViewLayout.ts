import { Actions, DockLocation, Model, type TabNode } from "flexlayout-react";
import type { PluginViewState } from "@/core/types";

export interface PluginViewTabInfo {
  viewId: string;
  tabId: string;
  tabsetId: string | null;
  title: string;
}

function isPluginViewTab(node: TabNode): boolean {
  return node.getComponent() === "plugin-view";
}

export function listPluginViewTabs(model: Model): PluginViewTabInfo[] {
  const tabs: PluginViewTabInfo[] = [];
  model.visitNodes((node) => {
    if (node.getType() !== "tab") {
      return;
    }
    const tabNode = node as TabNode;
    if (!isPluginViewTab(tabNode)) {
      return;
    }
    const config = (tabNode.getConfig() ?? {}) as { pluginViewId?: string };
    const tabset = tabNode.getParent();
    tabs.push({
      viewId: config.pluginViewId ?? tabNode.getId(),
      tabId: tabNode.getId(),
      tabsetId: tabset?.getType() === "tabset" ? tabset.getId() : null,
      title: tabNode.getName()
    });
  });
  return tabs;
}

export function syncPluginViewTabs(model: Model, openViews: PluginViewState[], fallbackTabsetId: string | null): void {
  const currentTabs = new Map(listPluginViewTabs(model).map((tab) => [tab.viewId, tab]));
  const openViewIds = new Set(openViews.map((view) => view.id));

  for (const [viewId, tab] of currentTabs) {
    if (openViewIds.has(viewId)) {
      continue;
    }
    model.doAction(Actions.deleteTab(tab.tabId));
  }

  for (const view of openViews) {
    const existing = currentTabs.get(view.id);
    if (!existing) {
      const targetTabsetId = view.preferredTabsetId ?? fallbackTabsetId;
      if (!targetTabsetId) {
        continue;
      }
      model.doAction(
        Actions.addNode(
          {
            type: "tab",
            id: view.tabId,
            name: view.title,
            component: "plugin-view",
            enableClose: true,
            config: {
              pluginViewId: view.id
            }
          },
          targetTabsetId,
          DockLocation.CENTER,
          -1,
          true
        )
      );
      continue;
    }
    if (existing.title !== view.title) {
      model.doAction(Actions.renameTab(existing.tabId, view.title));
    }
  }
}

export function focusPluginViewTab(model: Model, viewId: string | null): void {
  if (!viewId) {
    return;
  }
  const existing = listPluginViewTabs(model).find((tab) => tab.viewId === viewId);
  if (!existing) {
    return;
  }
  model.doAction(Actions.selectTab(existing.tabId));
}

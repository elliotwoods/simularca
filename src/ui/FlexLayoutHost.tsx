import { memo, useCallback, useEffect, useMemo } from "react";
import { Actions, DockLocation, Layout, Model, type IJsonModel, type TabNode } from "flexlayout-react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { sortOpenPluginViews } from "@/features/plugins/pluginViews";
import { LeftPanel } from "@/ui/panels/LeftPanel";
import { RightPanel } from "@/ui/panels/RightPanel";
import { ViewportPanel } from "@/ui/panels/ViewportPanel";
import { ConsolePanel } from "@/ui/panels/ConsolePanel";
import { PluginViewPanel } from "@/ui/panels/PluginViewPanel";
import { ProfilingResultsPanel } from "@/ui/panels/ProfilingResultsPanel";
import { focusPluginViewTab, listPluginViewTabs, syncPluginViewTabs } from "@/ui/pluginViewLayout";
import type { ProfileSessionResult } from "@/render/profiling";

const LAYOUT_STORAGE_KEY = "simularca:flex-layout:v1";
const PROFILE_RESULTS_TAB_ID = "tab.profiling-results";

type JsonLike = Record<string, unknown>;

function defaultLayoutConfig(): IJsonModel {
  return {
    global: {
      tabEnableClose: false,
      tabSetEnableMaximize: true
    },
    layout: {
      type: "column",
      children: [
        {
          type: "row",
          id: "panel.main",
          weight: 78,
          children: [
            {
              type: "tabset",
              id: "panel.left",
              weight: 22,
              children: [
                {
                  type: "tab",
                  id: "tab.left",
                  component: "left",
                  name: "Scene"
                }
              ]
            },
            {
              type: "tabset",
              id: "panel.center",
              weight: 56,
              children: [
                {
                  type: "tab",
                  id: "tab.viewport",
                  component: "center",
                  name: "Viewport"
                }
              ]
            },
            {
              type: "tabset",
              id: "panel.right",
              weight: 22,
              children: [
                {
                  type: "tab",
                  id: "tab.right",
                  component: "right",
                  name: "Inspector"
                }
              ]
            }
          ]
        },
        {
          type: "tabset",
          id: "panel.console",
          weight: 22,
          enableClose: false,
          children: [
            {
              type: "tab",
              id: "tab.console",
              component: "console",
              name: "Console"
            }
          ]
        }
      ]
    }
  };
}

function hasNode(config: unknown, predicate: (node: Record<string, unknown>) => boolean): boolean {
  if (!config || typeof config !== "object") {
    return false;
  }
  const node = config as Record<string, unknown>;
  if (predicate(node)) {
    return true;
  }
  const children = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  return children.some((child) => hasNode(child, predicate));
}

function withConsoleTabset(config: IJsonModel): IJsonModel {
  const layout = config.layout as unknown as Record<string, unknown> | undefined;
  if (!layout || hasNode(layout, (node) => node.id === "panel.console" || node.id === "tab.console")) {
    return config;
  }

  const existingLayout = structuredClone(layout);
  return {
    ...config,
    layout: {
      type: "column",
      id: "layout.withConsole",
      children: [
        {
          ...existingLayout,
          id: typeof existingLayout.id === "string" ? existingLayout.id : "panel.main",
          weight: typeof existingLayout.weight === "number" ? existingLayout.weight : 78
        },
        {
          type: "tabset",
          id: "panel.console",
          weight: 22,
          enableClose: false,
          children: [
            {
              type: "tab",
              id: "tab.console",
              component: "console",
              name: "Console"
            }
          ]
        }
      ]
    } as IJsonModel["layout"]
  };
}

function stripNodeSizeConstraints(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => stripNodeSizeConstraints(entry));
  }

  const source = node as JsonLike;
  if (source.component === "profiling-results" || source.id === PROFILE_RESULTS_TAB_ID) {
    return null;
  }
  const sanitized: JsonLike = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      key === "height" ||
      key === "width" ||
      key === "minHeight" ||
      key === "maxHeight" ||
      key === "minWidth" ||
      key === "maxWidth" ||
      key === "tabMinHeight" ||
      key === "tabMaxHeight" ||
      key === "tabMinWidth" ||
      key === "tabMaxWidth" ||
      key === "tabSetMinHeight" ||
      key === "tabSetMaxHeight" ||
      key === "tabSetMinWidth" ||
      key === "tabSetMaxWidth"
    ) {
      continue;
    }
    const sanitizedValue = stripNodeSizeConstraints(value);
    if (Array.isArray(sanitizedValue)) {
      sanitized[key] = sanitizedValue.filter((entry) => entry !== null);
    } else {
      sanitized[key] = sanitizedValue;
    }
  }
  const childArray = Array.isArray(sanitized.children) ? (sanitized.children as unknown[]) : null;
  if (
    childArray &&
    (sanitized.type === "tabset" || sanitized.type === "border") &&
    typeof sanitized.selected === "number"
  ) {
    if (childArray.length <= 0) {
      sanitized.selected = -1;
    } else {
      sanitized.selected = Math.max(0, Math.min(childArray.length - 1, Math.floor(sanitized.selected)));
    }
  }
  return sanitized;
}

export function sanitizeLayoutConfig(config: IJsonModel): IJsonModel {
  return stripNodeSizeConstraints(config) as IJsonModel;
}

function loadStoredLayoutConfig(): IJsonModel | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as IJsonModel;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const sanitized = sanitizeLayoutConfig(parsed);
    const normalizedRaw = JSON.stringify(sanitized);
    if (normalizedRaw !== raw) {
      localStorage.setItem(LAYOUT_STORAGE_KEY, normalizedRaw);
    }
    return sanitized;
  } catch {
    return null;
  }
}

function createLayoutModel(): Model {
  const config = withConsoleTabset(loadStoredLayoutConfig() ?? defaultLayoutConfig());
  try {
    return Model.fromJson(config);
  } catch {
    return Model.fromJson(defaultLayoutConfig());
  }
}

function persistLayoutConfig(model: Model): void {
  try {
    const sanitized = sanitizeLayoutConfig(model.toJson() as IJsonModel);
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Persist is best effort.
  }
}

function findTabsetIdForComponent(model: Model, component: string): string | null {
  let tabsetId: string | null = null;
  model.visitNodes((node) => {
    if (tabsetId || node.getType() !== "tab") {
      return;
    }
    const tabNode = node as TabNode;
    if (tabNode.getComponent() !== component) {
      return;
    }
    const parent = tabNode.getParent();
    if (parent?.getType() === "tabset") {
      tabsetId = parent.getId();
    }
  });
  return tabsetId;
}

function findViewportTabsetId(model: Model): string | null {
  return findTabsetIdForComponent(model, "center");
}

export function findPreferredProfileResultsTabsetId(model: Model): string | null {
  return findTabsetIdForComponent(model, "right") ?? findViewportTabsetId(model);
}

interface FlexLayoutHostProps {
  titleBar: React.ReactNode;
  topBar: React.ReactNode;
  pendingDropFileName?: string | null;
  viewportSuspended?: boolean;
  viewportFullscreen?: boolean;
  viewportScreenshotRequestId?: number;
  onViewportScreenshotBusyChange?: (busy: boolean) => void;
  profileResults: ProfileSessionResult | null;
  profileResultsOpen: boolean;
  onCloseProfileResults: () => void;
}

function findProfileResultsTab(model: Model): TabNode | null {
  let found: TabNode | null = null;
  model.visitNodes((node) => {
    if (found || node.getType() !== "tab") {
      return;
    }
    const tabNode = node as TabNode;
    if (tabNode.getId() === PROFILE_RESULTS_TAB_ID || tabNode.getComponent() === "profiling-results") {
      found = tabNode;
    }
  });
  return found;
}

function syncProfileResultsTab(
  model: Model,
  open: boolean,
  viewportTabsetId: string | null,
  title: string
): void {
  const existing = findProfileResultsTab(model);
  if (!open) {
    if (existing) {
      model.doAction(Actions.deleteTab(existing.getId()));
    }
    return;
  }
  if (existing) {
    model.doAction(Actions.selectTab(existing.getId()));
    return;
  }
  model.doAction(
    Actions.addNode(
      {
        type: "tab",
        id: PROFILE_RESULTS_TAB_ID,
        component: "profiling-results",
        name: title,
        enableClose: true
      },
      viewportTabsetId ?? "panel.center",
      DockLocation.CENTER,
      -1
    )
  );
  model.doAction(Actions.selectTab(PROFILE_RESULTS_TAB_ID));
}

const StableFlexLayoutSurface = memo(function StableFlexLayoutSurface(props: {
  model: Model;
  factory: (node: TabNode) => React.ReactNode;
  onModelChange: (model: Model) => void;
}) {
  return <Layout model={props.model} factory={props.factory} onModelChange={props.onModelChange} />;
});

export function FlexLayoutHost(props: FlexLayoutHostProps) {
  const kernel = useKernel();
  const pluginViewMap = useAppStore((store) => store.state.pluginViews);
  const focusedPluginViewId = useAppStore((store) => store.state.focusedPluginViewId);
  const pluginViews = useMemo(() => sortOpenPluginViews(pluginViewMap), [pluginViewMap]);
  const model = useMemo(() => createLayoutModel(), []);
  const viewportTabsetId = useMemo(() => findViewportTabsetId(model), [model]);
  const profileResultsTabsetId = useMemo(() => findPreferredProfileResultsTabsetId(model), [model]);

  useEffect(() => {
    if (!viewportTabsetId) {
      return;
    }
    const viewportIsMaximized = model.getMaximizedTabset()?.getId() === viewportTabsetId;
    if (viewportIsMaximized === Boolean(props.viewportFullscreen)) {
      return;
    }
    model.doAction(Actions.maximizeToggle(viewportTabsetId));
  }, [model, props.viewportFullscreen, viewportTabsetId]);

  useEffect(() => {
    syncPluginViewTabs(model, pluginViews, viewportTabsetId);
  }, [model, pluginViews, viewportTabsetId]);

  useEffect(() => {
    syncProfileResultsTab(
      model,
      props.profileResultsOpen && Boolean(props.profileResults),
      profileResultsTabsetId,
      props.profileResults
        ? `Performance Profile (${props.profileResults.frames.length}f)`
        : "Performance Profile"
    );
  }, [model, profileResultsTabsetId, props.profileResults, props.profileResultsOpen]);

  useEffect(() => {
    focusPluginViewTab(model, focusedPluginViewId);
  }, [focusedPluginViewId, model]);

  const handleModelChange = useCallback(
    (nextModel: Model) => {
      persistLayoutConfig(nextModel);
      const tabs = listPluginViewTabs(nextModel);
      const tabByViewId = new Map(tabs.map((tab) => [tab.viewId, tab]));
      const actions = kernel.store.getState().actions;
      for (const view of pluginViews) {
        const tab = tabByViewId.get(view.id);
        if (!tab) {
          actions.closePluginView(view.id);
          continue;
        }
        if (tab.tabsetId !== view.preferredTabsetId) {
          actions.setPluginViewTabset(view.id, tab.tabsetId);
        }
      }
      if (props.profileResultsOpen && !findProfileResultsTab(nextModel)) {
        props.onCloseProfileResults();
      }
    },
    [kernel, pluginViews, props.onCloseProfileResults, props.profileResultsOpen]
  );

  const factory = useCallback(
    (node: TabNode): React.ReactNode => {
      const component = node.getComponent();
      switch (component) {
        case "left":
          return <LeftPanel pendingDropFileName={props.pendingDropFileName} />;
        case "center":
          return (
            <ViewportPanel
              suspended={props.viewportSuspended}
              screenshotRequestId={props.viewportScreenshotRequestId}
              onScreenshotBusyChange={props.onViewportScreenshotBusyChange}
            />
          );
        case "right":
          return <RightPanel />;
        case "console":
          return <ConsolePanel />;
        case "plugin-view": {
          const config = (node.getConfig() ?? {}) as { pluginViewId?: string };
          return config.pluginViewId ? <PluginViewPanel pluginViewId={config.pluginViewId} /> : null;
        }
        case "profiling-results":
          return props.profileResults ? <ProfilingResultsPanel result={props.profileResults} /> : null;
        default:
          return null;
      }
    },
    [
      props.onViewportScreenshotBusyChange,
      props.pendingDropFileName,
      props.profileResults,
      props.viewportScreenshotRequestId,
      props.viewportSuspended
    ]
  );

  return (
    <div className={`layout-shell${props.viewportFullscreen ? " is-viewport-fullscreen" : ""}`}>
      <div className="layout-shell-title">{props.titleBar}</div>
      <div className="layout-shell-toolbar">{props.topBar}</div>
      <div className="flex-layout-host">
        <StableFlexLayoutSurface model={model} factory={factory} onModelChange={handleModelChange} />
      </div>
    </div>
  );
}

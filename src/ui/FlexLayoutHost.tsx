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
import type { PublishConfig } from "@/features/publish/publishConfigSchema";

const LAYOUT_STORAGE_KEY = "simularca:flex-layout:v1";
const VIEWER_LAYOUT_STORAGE_KEY = "simularca:flex-layout-viewer:v1";
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

function loadStoredLayoutConfig(storageKey: string): IJsonModel | null {
  try {
    const raw = localStorage.getItem(storageKey);
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
      localStorage.setItem(storageKey, normalizedRaw);
    }
    return sanitized;
  } catch {
    return null;
  }
}

/**
 * In viewer mode the layout is derived either from a publisher-supplied
 * `viewerConfig.layout` (an `IJsonModel`) or from `viewerConfig.panels` when
 * no custom layout is set. Each publish recomputes a fresh layout so viewer
 * setting changes between publishes are immediately visible without stale
 * localStorage clobbering them.
 */
export function defaultViewerLayoutConfig(viewerConfig: PublishConfig): IJsonModel {
  const mainChildren: Array<Record<string, unknown>> = [];
  if (viewerConfig.panels.sceneTree) {
    mainChildren.push({
      type: "tabset",
      id: "panel.left",
      weight: 22,
      children: [{ type: "tab", id: "tab.left", component: "left", name: "Scene" }]
    });
  }
  mainChildren.push({
    type: "tabset",
    id: "panel.center",
    weight: 56,
    children: [{ type: "tab", id: "tab.viewport", component: "center", name: "Viewport" }]
  });
  if (viewerConfig.panels.inspector) {
    mainChildren.push({
      type: "tabset",
      id: "panel.right",
      weight: 22,
      children: [{ type: "tab", id: "tab.right", component: "right", name: "Inspector" }]
    });
  }
  const layoutChildren: Array<Record<string, unknown>> = [
    { type: "row", id: "panel.main", weight: 78, children: mainChildren }
  ];
  if (viewerConfig.panels.console) {
    layoutChildren.push({
      type: "tabset",
      id: "panel.console",
      weight: 22,
      enableClose: false,
      children: [{ type: "tab", id: "tab.console", component: "console", name: "Console" }]
    });
  }
  return {
    global: { tabEnableClose: false, tabSetEnableMaximize: true },
    layout: { type: "column", children: layoutChildren }
  } as unknown as IJsonModel;
}

const PANEL_TO_COMPONENT: Partial<Record<keyof PublishConfig["panels"], string>> = {
  sceneTree: "left",
  inspector: "right",
  console: "console"
};

interface LayoutNode {
  type?: string;
  id?: string;
  component?: string;
  children?: LayoutNode[];
  [key: string]: unknown;
}

function defaultTabsetForComponent(component: string): LayoutNode | null {
  if (component === "left") {
    return {
      type: "tabset",
      id: "panel.left",
      weight: 22,
      children: [{ type: "tab", id: "tab.left", component: "left", name: "Scene" }]
    };
  }
  if (component === "right") {
    return {
      type: "tabset",
      id: "panel.right",
      weight: 22,
      children: [{ type: "tab", id: "tab.right", component: "right", name: "Inspector" }]
    };
  }
  if (component === "console") {
    return {
      type: "tabset",
      id: "panel.console",
      weight: 22,
      enableClose: false,
      children: [{ type: "tab", id: "tab.console", component: "console", name: "Console" }]
    };
  }
  return null;
}

function layoutHasComponent(node: LayoutNode | undefined, component: string): boolean {
  if (!node) return false;
  if (node.type === "tab" && node.component === component) return true;
  if (Array.isArray(node.children)) {
    return node.children.some((child) => layoutHasComponent(child, component));
  }
  return false;
}

/**
 * Walk the tree pruning any tab whose `component === target`. Tabsets and
 * rows that become empty as a result are also pruned so flexlayout doesn't
 * render hollow containers.
 */
function removeComponent(node: LayoutNode, component: string): void {
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    removeComponent(child, component);
  }
  node.children = node.children.filter((child) => {
    if (child.type === "tab" && child.component === component) return false;
    const isContainer = child.type === "tabset" || child.type === "row" || child.type === "column";
    if (isContainer && Array.isArray(child.children) && child.children.length === 0) return false;
    return true;
  });
}

function findRowById(node: LayoutNode | undefined, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "row" && node.id === id) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findRowById(child, id);
      if (hit) return hit;
    }
  }
  return null;
}

function insertDefaultTabset(model: { layout?: LayoutNode }, component: string): void {
  const tabset = defaultTabsetForComponent(component);
  if (!tabset || !model.layout) return;
  const root = model.layout;
  if (component === "console") {
    if (root.type === "column" && Array.isArray(root.children)) {
      root.children.push(tabset);
    } else {
      // Root is not a column — wrap it so console gets a stripe below it.
      model.layout = {
        type: "column",
        children: [root, tabset]
      };
    }
    return;
  }
  // sceneTree / inspector live inside `panel.main`. Fall back to the root
  // node when the user has dragged the layout into a shape that no longer
  // has that id.
  const mainRow = findRowById(root, "panel.main") ?? root;
  if (!Array.isArray(mainRow.children)) {
    mainRow.children = [];
  }
  if (component === "left") {
    mainRow.children = [tabset, ...mainRow.children];
  } else {
    mainRow.children = [...mainRow.children, tabset];
  }
}

/**
 * Bring a layout JSON into agreement with a `panels` flag set: every panel
 * whose flag is `true` must have its tab present; every flag that's `false`
 * must have its tab absent. Use this when a saved layout is loaded against
 * (potentially mismatched) panel flags — e.g. when the publish modal opens
 * with a defaultPublishLayout that pre-dates a panel toggle.
 */
export function reconcileLayoutWithPanels(
  layout: IJsonModel,
  panels: PublishConfig["panels"]
): IJsonModel {
  let result = layout;
  for (const key of Object.keys(PANEL_TO_COMPONENT) as Array<keyof PublishConfig["panels"]>) {
    result = applyPanelToggleToLayout(result, key, Boolean(panels[key]));
  }
  return result;
}

/**
 * Add or remove a panel's default tabset from a layout JSON in response to a
 * panel-visibility toggle in the publish modal. Preserves the rest of the
 * user's drag arrangement; for layouts diverged far from the default the
 * insertion falls back to the layout root so the toggle still has a visible
 * effect.
 */
export function applyPanelToggleToLayout(
  layout: IJsonModel,
  panelKey: keyof PublishConfig["panels"],
  enabled: boolean
): IJsonModel {
  const component = PANEL_TO_COMPONENT[panelKey];
  if (!component) return layout;
  const cloned = JSON.parse(JSON.stringify(layout)) as IJsonModel & { layout?: LayoutNode };
  const present = layoutHasComponent(cloned.layout as LayoutNode | undefined, component);
  if (enabled && !present) {
    insertDefaultTabset(cloned, component);
  } else if (!enabled && present) {
    if (cloned.layout) {
      removeComponent(cloned.layout as LayoutNode, component);
    }
  }
  return sanitizeLayoutConfig(cloned);
}

function viewerLayoutConfig(viewerConfig: PublishConfig): IJsonModel {
  const custom = viewerConfig.layout;
  if (custom && typeof custom === "object") {
    return sanitizeLayoutConfig(custom as IJsonModel);
  }
  return defaultViewerLayoutConfig(viewerConfig);
}

function createLayoutModel(viewerConfig: PublishConfig | null): Model {
  if (viewerConfig) {
    try {
      return Model.fromJson(viewerLayoutConfig(viewerConfig));
    } catch {
      return Model.fromJson(defaultLayoutConfig());
    }
  }
  const config = withConsoleTabset(loadStoredLayoutConfig(LAYOUT_STORAGE_KEY) ?? defaultLayoutConfig());
  try {
    return Model.fromJson(config);
  } catch {
    return Model.fromJson(defaultLayoutConfig());
  }
}

function persistLayoutConfig(model: Model, storageKey: string): void {
  try {
    const sanitized = sanitizeLayoutConfig(model.toJson() as IJsonModel);
    localStorage.setItem(storageKey, JSON.stringify(sanitized));
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
  viewportScreenshotUseVideoRenderSettings?: boolean;
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
  const viewerConfig = kernel.viewerConfig ?? null;
  const layoutStorageKey = viewerConfig ? VIEWER_LAYOUT_STORAGE_KEY : LAYOUT_STORAGE_KEY;
  const model = useMemo(() => createLayoutModel(viewerConfig), [viewerConfig]);
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
      persistLayoutConfig(nextModel, layoutStorageKey);
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
    [kernel, layoutStorageKey, pluginViews, props.onCloseProfileResults, props.profileResultsOpen]
  );

  const factory = useCallback(
    (node: TabNode): React.ReactNode => {
      const component = node.getComponent();
      switch (component) {
        case "left":
          if (viewerConfig && !viewerConfig.panels.sceneTree) {
            return null;
          }
          return <LeftPanel pendingDropFileName={props.pendingDropFileName} />;
        case "center":
          return (
            <ViewportPanel
              suspended={props.viewportSuspended}
              screenshotRequestId={props.viewportScreenshotRequestId}
              screenshotUseVideoRenderSettings={props.viewportScreenshotUseVideoRenderSettings}
              onScreenshotBusyChange={props.onViewportScreenshotBusyChange}
            />
          );
        case "right":
          if (viewerConfig && !viewerConfig.panels.inspector) {
            return null;
          }
          return <RightPanel />;
        case "console":
          if (viewerConfig && !viewerConfig.panels.console) {
            return null;
          }
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
      props.viewportScreenshotUseVideoRenderSettings,
      props.viewportSuspended,
      viewerConfig
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

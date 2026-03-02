import { useMemo } from "react";
import { Layout, Model, type IJsonModel, type TabNode } from "flexlayout-react";
import { LeftPanel } from "@/ui/panels/LeftPanel";
import { RightPanel } from "@/ui/panels/RightPanel";
import { ViewportPanel } from "@/ui/panels/ViewportPanel";
import { ConsolePanel } from "@/ui/panels/ConsolePanel";

const LAYOUT_STORAGE_KEY = "simularca:flex-layout:v1";

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
    return parsed;
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
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(model.toJson()));
  } catch {
    // Persist is best effort.
  }
}

interface FlexLayoutHostProps {
  titleBar: React.ReactNode;
  topBar: React.ReactNode;
}

export function FlexLayoutHost(props: FlexLayoutHostProps) {
  const model = useMemo(() => createLayoutModel(), []);

  const factory = (node: TabNode): React.ReactNode => {
    const component = node.getComponent();
    switch (component) {
      case "left":
        return <LeftPanel />;
      case "center":
        return <ViewportPanel />;
      case "right":
        return <RightPanel />;
      case "console":
        return <ConsolePanel />;
      default:
        return null;
    }
  };

  return (
    <div className="layout-shell">
      <div className="layout-shell-title">{props.titleBar}</div>
      <div className="layout-shell-toolbar">{props.topBar}</div>
      <div className="flex-layout-host">
        <Layout model={model} factory={factory} onModelChange={persistLayoutConfig} />
      </div>
    </div>
  );
}

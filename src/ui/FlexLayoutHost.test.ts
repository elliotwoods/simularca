import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, type IJsonModel } from "flexlayout-react";
import type { AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { createAppStore } from "@/core/store/appStore";
import { ActorProfilingService } from "@/render/profiling";
import { FlexLayoutHost, findPreferredProfileResultsTabsetId, sanitizeLayoutConfig } from "@/ui/FlexLayoutHost";

let mockLayoutRenderCount = 0;
let mockViewportMountCount = 0;
let mockViewportUnmountCount = 0;

vi.mock("flexlayout-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("flexlayout-react")>();
  const ReactModule = await import("react");
  return {
    ...actual,
    Layout: (props: { factory: (node: { getComponent(): string; getConfig(): unknown }) => React.ReactNode }) => {
      mockLayoutRenderCount += 1;
      return ReactModule.createElement(
        "div",
        { "data-testid": "mock-flex-layout" },
        props.factory({
          getComponent: () => "center",
          getConfig: () => null
        })
      );
    }
  };
});

vi.mock("@/ui/panels/ViewportPanel", async () => {
  const ReactModule = await import("react");
  return {
    ViewportPanel: () => {
      ReactModule.useEffect(() => {
        mockViewportMountCount += 1;
        return () => {
          mockViewportUnmountCount += 1;
        };
      }, []);
      return ReactModule.createElement("div", { "data-testid": "mock-viewport-panel" }, "Viewport");
    }
  };
});

vi.mock("@/ui/panels/LeftPanel", () => ({
  LeftPanel: () => React.createElement("div", null, "Left")
}));

vi.mock("@/ui/panels/RightPanel", () => ({
  RightPanel: () => React.createElement("div", null, "Right")
}));

vi.mock("@/ui/panels/ConsolePanel", () => ({
  ConsolePanel: () => React.createElement("div", null, "Console")
}));

vi.mock("@/ui/panels/PluginViewPanel", () => ({
  PluginViewPanel: () => React.createElement("div", null, "Plugin")
}));

vi.mock("@/ui/panels/ProfilingResultsPanel", () => ({
  ProfilingResultsPanel: () => React.createElement("div", null, "Profile")
}));

function createKernelStub(): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    descriptorRegistry: {} as AppKernel["descriptorRegistry"],
    pluginApi: {
      listPlugins: () => [],
      subscribe: () => () => undefined,
      getRevision: () => 0
    } as unknown as AppKernel["pluginApi"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("sanitizeLayoutConfig", () => {
  it("clamps tabset selected index after profiling tab removal", () => {
    const config = {
      global: {
        tabEnableClose: false
      },
      layout: {
        type: "tabset",
        id: "panel.center",
        selected: 1,
        children: [
          {
            type: "tab",
            id: "tab.viewport",
            component: "center",
            name: "Viewport"
          },
          {
            type: "tab",
            id: "tab.profiling-results",
            component: "profiling-results",
            name: "Profile"
          }
        ]
      }
    } as unknown as IJsonModel;

    const sanitized = sanitizeLayoutConfig(config) as IJsonModel & {
      layout: {
        selected?: number;
        children?: Array<{ id: string }>;
      };
    };

    expect(sanitized.layout.children).toEqual([{ id: "tab.viewport", component: "center", name: "Viewport", type: "tab" }]);
    expect(sanitized.layout.selected).toBe(0);
  });
});

describe("FlexLayoutHost", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockLayoutRenderCount = 0;
    mockViewportMountCount = 0;
    mockViewportUnmountCount = 0;
    if (typeof localStorage.clear === "function") {
      localStorage.clear();
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the layout surface and viewport mounted when only the toolbar content changes", async () => {
    const kernel = createKernelStub();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async (toolbarLabel: string) => {
      await act(async () => {
        root.render(
          React.createElement(
            KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
            { kernel },
            React.createElement(FlexLayoutHost, {
              titleBar: React.createElement("div", null, "Title"),
              topBar: React.createElement("div", null, toolbarLabel),
              profileResults: null,
              profileResultsOpen: false,
              onCloseProfileResults: () => undefined
            })
          )
        );
      });
    };

    await render("Toolbar A");
    await render("Toolbar B");

    expect(mockLayoutRenderCount).toBeGreaterThanOrEqual(1);
    expect(mockViewportMountCount).toBe(1);
    expect(mockViewportUnmountCount).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });
});

describe("findPreferredProfileResultsTabsetId", () => {
  it("prefers the inspector tabset over the viewport tabset", () => {
    const model = Model.fromJson({
      global: {
        tabEnableClose: false
      },
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
          },
          {
            type: "tabset",
            id: "panel.right",
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
      }
    } as IJsonModel);

    expect(findPreferredProfileResultsTabsetId(model)).toBe("panel.right");
  });

  it("falls back to the viewport tabset when the inspector tabset is missing", () => {
    const model = Model.fromJson({
      global: {
        tabEnableClose: false
      },
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
    } as unknown as IJsonModel);

    expect(findPreferredProfileResultsTabsetId(model)).toBe("panel.center");
  });
});

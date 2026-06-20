import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type { AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { createAppStore } from "@/core/store/appStore";
import { ActorProfilingService, type ProfilingPublicState } from "@/render/profiling";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";

class ResizeObserverMock {
  public observe(): void {}
  public disconnect(): void {}
  public unobserve(): void {}
}

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

const idleProfilingState: ProfilingPublicState = {
  phase: "idle",
  requestedFrameCount: 0,
  capturedFrameCount: 0,
  pendingGpuFrames: 0,
  options: null,
  result: null
};

describe("TopBarPanel screenshot button", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      window.clearTimeout(handle);
    });
  });

  afterEach(() => {
    if (originalResizeObserver) {
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    if (originalRequestAnimationFrame) {
      vi.stubGlobal("requestAnimationFrame", originalRequestAnimationFrame);
    }
    if (originalCancelAnimationFrame) {
      vi.stubGlobal("cancelAnimationFrame", originalCancelAnimationFrame);
    }
    document.body.innerHTML = "";
  });

  it("disables the screenshot button when unavailable or busy and triggers capture when ready", async () => {
    const kernel = createKernelStub();
    const onCaptureViewportScreenshot = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async (props: { canCaptureViewportScreenshot: boolean; viewportScreenshotBusy: boolean }) => {
      await act(async () => {
        root.render(
          React.createElement(
            KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
            { kernel },
            React.createElement(TopBarPanel, {
              onToggleKeyboardMap: () => undefined,
              onOpenRender: () => undefined,
              onOpenPrint: () => undefined,
              onOpenProfiling: () => undefined,
              profilingState: idleProfilingState,
              onCaptureViewportScreenshot,
              canCaptureViewportScreenshot: props.canCaptureViewportScreenshot,
              viewportScreenshotBusy: props.viewportScreenshotBusy,
              requestTextInput: async () => null
            })
          )
        );
      });
    };

    await render({
      canCaptureViewportScreenshot: false,
      viewportScreenshotBusy: false
    });

    let screenshotButton = container.querySelector("button[aria-label='Copy viewport screenshot to clipboard']") as
      | HTMLButtonElement
      | null;
    expect(screenshotButton).not.toBeNull();
    expect(screenshotButton?.disabled).toBe(true);
    expect(screenshotButton?.title).toContain("desktop only");

    await render({
      canCaptureViewportScreenshot: true,
      viewportScreenshotBusy: true
    });
    screenshotButton = container.querySelector("button[aria-label='Copy viewport screenshot to clipboard']") as
      | HTMLButtonElement
      | null;
    expect(screenshotButton?.disabled).toBe(true);
    expect(screenshotButton?.title).toContain("in progress");

    await render({
      canCaptureViewportScreenshot: true,
      viewportScreenshotBusy: false
    });
    screenshotButton = container.querySelector("button[aria-label='Copy viewport screenshot to clipboard']") as
      | HTMLButtonElement
      | null;
    expect(screenshotButton?.disabled).toBe(false);

    await act(async () => {
      screenshotButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCaptureViewportScreenshot).toHaveBeenCalledTimes(1);
    expect(onCaptureViewportScreenshot.mock.calls[0]?.[0]?.shiftKey).toBe(false);

    // Shift-click → handler receives a synthetic event whose shiftKey is
    // true, so App can switch to the "video-render look" capture path.
    await act(async () => {
      screenshotButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    expect(onCaptureViewportScreenshot).toHaveBeenCalledTimes(2);
    expect(onCaptureViewportScreenshot.mock.calls[1]?.[0]?.shiftKey).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("removes create and plugins controls and adapts toolbar layout modes as width changes", async () => {
    const kernel = createKernelStub();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(TopBarPanel, {
            onToggleKeyboardMap: () => undefined,
            onOpenRender: () => undefined,
              onOpenPrint: () => undefined,
            onOpenProfiling: () => undefined,
            profilingState: idleProfilingState,
            onCaptureViewportScreenshot: () => undefined,
            canCaptureViewportScreenshot: true,
            viewportScreenshotBusy: false,
            requestTextInput: async () => null
          })
        )
      );
    });

    expect(container.textContent).not.toContain("Create");
    expect(container.textContent).not.toContain("Plugins");

    const toolbar = container.querySelector(".top-toolbar") as HTMLDivElement | null;
    expect(toolbar).not.toBeNull();
    const toolbarEl = toolbar!;

    let toolbarWidth = 1200;
    Object.defineProperty(toolbarEl, "clientWidth", {
      configurable: true,
      get: () => toolbarWidth
    });
    Object.defineProperty(toolbarEl, "scrollWidth", {
      configurable: true,
      get: () => {
        if (toolbarEl.classList.contains("is-scroll")) {
          return toolbarWidth + 120;
        }
        if (toolbarEl.classList.contains("is-wrapped")) {
          return toolbarWidth <= 430 ? toolbarWidth + 90 : toolbarWidth - 10;
        }
        if (toolbarEl.classList.contains("is-compact")) {
          return toolbarWidth <= 620 ? toolbarWidth + 90 : toolbarWidth - 10;
        }
        return toolbarWidth <= 900 ? toolbarWidth + 180 : toolbarWidth - 10;
      }
    });

    const resizeToolbar = async (nextWidth: number) => {
      toolbarWidth = nextWidth;
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };

    await resizeToolbar(1200);
    expect(toolbarEl.dataset.layoutMode).toBe("full");

    await resizeToolbar(820);
    expect(toolbarEl.dataset.layoutMode).toBe("compact");

    await resizeToolbar(560);
    expect(toolbarEl.dataset.layoutMode).toBe("wrapped");

    await resizeToolbar(360);
    expect(toolbarEl.dataset.layoutMode).toBe("scroll");

    await resizeToolbar(1400);
    expect(toolbarEl.dataset.layoutMode).toBe("full");

    await act(async () => {
      root.unmount();
    });
  });

  it("toggles toolbar section visibility from the right-click menu and persists it to the store", async () => {
    const kernel = createKernelStub();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(TopBarPanel, {
            onToggleKeyboardMap: () => undefined,
            onOpenRender: () => undefined,
            onOpenPrint: () => undefined,
            onOpenProfiling: () => undefined,
            profilingState: idleProfilingState,
            onCaptureViewportScreenshot: () => undefined,
            canCaptureViewportScreenshot: true,
            viewportScreenshotBusy: false,
            requestTextInput: async () => null
          })
        )
      );
    });

    const toolbar = container.querySelector(".top-toolbar") as HTMLDivElement | null;
    expect(toolbar).not.toBeNull();

    // No menu until right-clicked.
    expect(document.querySelector(".toolbar-section-menu")).toBeNull();

    await act(async () => {
      toolbar?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 8 })
      );
    });

    const menu = document.querySelector(".toolbar-section-menu") as HTMLDivElement | null;
    expect(menu).not.toBeNull();
    const options = menu!.querySelectorAll("button[role='menuitemcheckbox']");
    expect(options.length).toBe(8);

    const fpsOption = Array.from(options).find((el) => el.textContent?.includes("FPS")) as
      | HTMLButtonElement
      | undefined;
    expect(fpsOption).toBeTruthy();
    expect(fpsOption?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fpsOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Store now records the section as hidden, and the menu stays open with the
    // updated check state so multiple sections can be toggled in one pass.
    expect(kernel.store.getState().state.toolbarVisibility.fps).toBe(false);
    expect(kernel.store.getState().state.dirty).toBe(true);
    const fpsOptionAfter = Array.from(
      document.querySelectorAll(".toolbar-section-menu button[role='menuitemcheckbox']")
    ).find((el) => el.textContent?.includes("FPS")) as HTMLButtonElement | undefined;
    expect(fpsOptionAfter?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens performance profile capture from the toolbar button", async () => {
    const kernel = createKernelStub();
    const onOpenProfiling = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
          { kernel },
          React.createElement(TopBarPanel, {
            onToggleKeyboardMap: () => undefined,
            onOpenRender: () => undefined,
              onOpenPrint: () => undefined,
            onOpenProfiling,
            profilingState: idleProfilingState,
            onCaptureViewportScreenshot: () => undefined,
            canCaptureViewportScreenshot: true,
            viewportScreenshotBusy: false,
            requestTextInput: async () => null
          })
        )
      );
    });

    const profileButton = container.querySelector("button[aria-label='Open performance profile']") as
      | HTMLButtonElement
      | null;
    expect(profileButton).not.toBeNull();

    await act(async () => {
      profileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenProfiling).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".toolbar-profile-progress")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

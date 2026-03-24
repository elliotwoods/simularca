import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type { AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { createAppStore } from "@/core/store/appStore";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";

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
    clock: {} as AppKernel["clock"]
  };
}

describe("TopBarPanel screenshot button", () => {
  afterEach(() => {
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

    await act(async () => {
      root.unmount();
    });
  });
});

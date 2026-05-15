import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUnattributedGraphNodes, ProfilingResultsPanel } from "@/ui/panels/ProfilingResultsPanel";
import type { ProfileSessionResult } from "@/render/profiling";

function createResult(): ProfileSessionResult {
  return {
    id: "profile-session:test",
    options: {
      frameCount: 2,
      includeUpdateTimings: true,
      includeDrawTimings: true,
      includeGpuTimings: true,
      detailPreset: "standard"
    },
    startedAtIso: "2026-04-02T00:00:00.000Z",
    completedAtIso: "2026-04-02T00:00:01.000Z",
    frames: [
      {
        frameIndex: 0,
        cpu: {
          totalDurationMs: 10,
          roots: [
            {
              id: "frame:scene-sync",
              label: "Scene sync",
              durationMs: 6,
              children: [
                {
                  id: "frame:scene-sync/update-loop",
                  label: "Actor update loop",
                  durationMs: 3,
                  children: []
                }
              ]
            },
            {
              id: "frame:render-submission",
              label: "Render submission",
              durationMs: 4,
              children: []
            }
          ]
        },
        gpu: {
          status: "captured",
          totalDurationMs: 2,
          roots: [
            {
              id: "gpu:render",
              label: "Render",
              durationMs: 2,
              children: []
            }
          ]
        },
        actors: []
      },
      {
        frameIndex: 1,
        cpu: {
          totalDurationMs: 7,
          roots: [
            {
              id: "frame:scene-sync",
              label: "Scene sync",
              durationMs: 7,
              children: []
            }
          ]
        },
        gpu: {
          status: "unavailable",
          totalDurationMs: null,
          roots: []
        },
        actors: []
      }
    ],
    summary: {
      frameCount: 2,
      cpu: {
        averageFrameMs: 8.5,
        maxFrameMs: 10,
        maxProcessMs: 7,
        topProcesses: []
      },
      gpu: {
        status: "captured",
        availableFrames: 1,
        metrics: {
          averageFrameMs: 2,
          maxFrameMs: 2,
          maxProcessMs: 2
        },
        topProcesses: []
      },
      hotActors: []
    }
  };
}

describe("addUnattributedGraphNodes", () => {
  it("adds residual timing nodes at both root and nested levels", () => {
    const graph = addUnattributedGraphNodes({
      id: "root",
      label: "Root",
      durationMs: 10,
      children: [
        {
          id: "child",
          label: "Child",
          durationMs: 6,
          children: [
            {
              id: "grandchild",
              label: "Grandchild",
              durationMs: 2,
              children: []
            }
          ]
        }
      ]
    });

    expect(graph.children.map((child) => child.label)).toEqual(["Child", "Unattributed"]);
    expect(graph.children[1]?.durationMs).toBe(4);
    expect(graph.children[0]?.children.map((child) => child.label)).toEqual(["Unattributed", "Grandchild"]);
    expect(graph.children[0]?.children[0]?.durationMs).toBe(4);
  });

  it("skips residual nodes when the remaining time is below the threshold", () => {
    const graph = addUnattributedGraphNodes({
      id: "root",
      label: "Root",
      durationMs: 1,
      children: [
        {
          id: "child",
          label: "Child",
          durationMs: 0.995,
          children: []
        }
      ]
    });

    expect(graph.children).toHaveLength(1);
    expect(graph.children[0]?.label).toBe("Child");
  });
});

describe("ProfilingResultsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders summaries before the combined frames section", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ProfilingResultsPanel, { result: createResult() }));
    });

    expect(container.textContent).toContain("Performance Profile");
    const sectionTitles = Array.from(container.querySelectorAll(".profile-section-header strong")).map((node) =>
      node.textContent?.trim()
    );
    expect(sectionTitles.slice(0, 4)).toEqual([
      "Summaries",
      "Captured Frames",
      "Actor CPU Hotspots",
      "Plugin CPU Hotspots"
    ]);
    expect(container.textContent).not.toContain("CPU Across Frames");
    expect(container.textContent).not.toContain("GPU Across Frames");
    expect(container.querySelector(".profile-section-break .profile-section-header strong")?.textContent).toBe(
      "Actor CPU Hotspots"
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows combined frame expansion and the inline drilldown rail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ProfilingResultsPanel, { result: createResult() }));
    });

    expect(container.textContent ?? "").not.toContain("CPU Total");
    expect(container.textContent ?? "").toContain("Captured Frames");
    expect(container.textContent ?? "").not.toContain("Frame 1");
    expect(container.querySelector(".profile-summary-chip-label")?.textContent).toBe("Frames");

    const frameButton = Array.from(container.querySelectorAll("button")).find((button) =>
      ((button as HTMLButtonElement).getAttribute("aria-label") ?? "").includes(
        "Frame 1: CPU 10.0 ms | GPU 2.00 ms (drill down)"
      )
    ) as HTMLButtonElement | undefined;
    expect(frameButton).toBeDefined();
    expect(frameButton?.textContent?.trim()).toBe("1");

    await act(async () => {
      frameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent ?? "").toContain("CPU Total");
    expect(container.textContent ?? "").toContain("GPU Total");
    expect(container.textContent ?? "").toContain("#1");
    expect(container.querySelector(".profile-frame-expanded-stack")).not.toBeNull();
    expect(container.querySelectorAll(".profile-inline-drilldown-rail")).toHaveLength(1);

    const segmentButton = Array.from(container.querySelectorAll("button")).find((button) =>
      ((button as HTMLButtonElement).getAttribute("aria-label") ?? "").includes(
        "Scene sync: 6.00 ms (drill down)"
      )
    ) as HTMLButtonElement | undefined;
    expect(segmentButton).toBeDefined();

    await act(async () => {
      segmentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelectorAll(".profile-inline-drilldown-rail")).toHaveLength(2);
    expect(container.querySelector(".profile-inline-drilldown-card")).toBeNull();
    expect(container.querySelector(".profile-inline-drilldown-caption")).toBeNull();
    expect(container.querySelector(".profile-inline-drilldown-meta")?.textContent ?? "").toContain("Scene sync");
    expect(container.querySelector(".profile-inline-drilldown-meta")?.textContent ?? "").toContain("6.00 ms");

    await act(async () => {
      segmentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelectorAll(".profile-inline-drilldown-rail")).toHaveLength(1);
    expect(container.querySelector(".profile-inline-drilldown-meta")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

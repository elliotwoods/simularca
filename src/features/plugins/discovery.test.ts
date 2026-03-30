import { describe, expect, it } from "vitest";
import { formatPluginDiscoverySummary, type PluginDiscoveryReport } from "@/features/plugins/discovery";

describe("formatPluginDiscoverySummary", () => {
  it("formats counts when there are no failures", () => {
    const report: PluginDiscoveryReport = {
      discovered: [{ modulePath: "file:///plugins/a/dist/index.js", sourceGroup: "plugins-local", updatedAtMs: 1, version: "0.1.0" }],
      addedCount: 1,
      reloadedCount: 0,
      failed: []
    };
    expect(formatPluginDiscoverySummary(report)).toBe("Discovered 1, loaded 1 (1 new, 0 reloaded), failed 0.");
  });

  it("includes first failure message when failures exist", () => {
    const report: PluginDiscoveryReport = {
      discovered: [{ modulePath: "file:///plugins/a/dist/index.js", sourceGroup: "plugins-local", updatedAtMs: 1, version: "0.1.0" }],
      addedCount: 0,
      reloadedCount: 0,
      failed: [
        {
          modulePath: "file:///plugins/a/dist/index.js",
          error: "Plugin module failed to import."
        }
      ]
    };
    expect(formatPluginDiscoverySummary(report)).toBe(
      "Discovered 1, loaded 0 (0 new, 0 reloaded), failed 1. First failure: Plugin module failed to import."
    );
  });
});

import { describe, expect, it } from "vitest";
import { formatPluginDiscoverySummary, type PluginDiscoveryReport } from "@/features/plugins/discovery";

describe("formatPluginDiscoverySummary", () => {
  it("formats counts when there are no failures", () => {
    const report: PluginDiscoveryReport = {
      discovered: [{ modulePath: "file:///plugins/a/dist/index.js", sourceGroup: "plugins-local" }],
      loadedCount: 1,
      failed: []
    };
    expect(formatPluginDiscoverySummary(report)).toBe("Discovered 1, loaded 1, failed 0.");
  });

  it("includes first failure message when failures exist", () => {
    const report: PluginDiscoveryReport = {
      discovered: [{ modulePath: "file:///plugins/a/dist/index.js", sourceGroup: "plugins-local" }],
      loadedCount: 0,
      failed: [
        {
          modulePath: "file:///plugins/a/dist/index.js",
          error: "Plugin module failed to import."
        }
      ]
    };
    expect(formatPluginDiscoverySummary(report)).toBe(
      "Discovered 1, loaded 0, failed 1. First failure: Plugin module failed to import."
    );
  });
});


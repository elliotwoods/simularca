import { describe, expect, it } from "vitest";
import { resolvePluginModuleSpecifier } from "@/features/plugins/pluginLoader";

describe("resolvePluginModuleSpecifier", () => {
  it("rewrites local file URL to vite @fs path in http runtime", () => {
    const resolved = resolvePluginModuleSpecifier(
      "file:///C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js",
      "http:"
    );
    expect(resolved).toBe("/@fs/C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js");
  });

  it("keeps file URL in non-http runtime", () => {
    const resolved = resolvePluginModuleSpecifier(
      "file:///C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js",
      "file:"
    );
    expect(resolved).toBe("file:///C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js");
  });

  it("keeps non-file specifiers unchanged", () => {
    expect(resolvePluginModuleSpecifier("/plugins/thread-spindle-plugin/dist/index.js", "http:")).toBe(
      "/plugins/thread-spindle-plugin/dist/index.js"
    );
  });
});


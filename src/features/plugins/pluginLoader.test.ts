import { describe, expect, it } from "vitest";
import { applyPluginVersionOverride, resolvePluginModuleSpecifier } from "@/features/plugins/pluginLoader";

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

  it("appends a cache-busting token when provided", () => {
    const resolved = resolvePluginModuleSpecifier(
      "file:///C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js",
      "http:",
      123
    );
    expect(resolved).toBe("/@fs/C:/dev/simularca/plugins-local/thread-spindle-plugin/dist/index.js?v=123");
  });
});

describe("applyPluginVersionOverride", () => {
  it("overrides the manifest version when discovery provides one", () => {
    expect(
      applyPluginVersionOverride(
        {
          handshakeVersion: 1,
          id: "example.wave",
          name: "Example Wave Plugin",
          version: "0.1.0",
          engine: {
            minApiVersion: 1,
            maxApiVersion: 1
          }
        },
        "0.1.7"
      ).version
    ).toBe("0.1.7");
  });

  it("keeps the manifest version when no override exists", () => {
    expect(
      applyPluginVersionOverride(
        {
          handshakeVersion: 1,
          id: "example.wave",
          name: "Example Wave Plugin",
          version: "0.1.0",
          engine: {
            minApiVersion: 1,
            maxApiVersion: 1
          }
        },
        undefined
      ).version
    ).toBe("0.1.0");
  });
});

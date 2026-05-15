import { describe, expect, it } from "vitest";
import handshake from "../../../plugins/roto-control-plugin/src/index";
import { augmentInternalPluginDefinition } from "@/features/plugins/internalPluginAugmentations";

describe("internal plugin augmentations", () => {
  it("attaches the app-side roto-control UI to the discovered plugin package", () => {
    const plugin = augmentInternalPluginDefinition(handshake.manifest.id, handshake.createPlugin());

    expect(plugin.id).toBe("plugin.rotoControl");
    expect(plugin.name).toBe("Roto-Control");
    expect(plugin.inspectorComponent).toBeTypeOf("function");
    expect(plugin.rotoControlComponent).toBeTypeOf("function");
    expect(plugin.runtimeComponent).toBeTypeOf("function");
  });
});

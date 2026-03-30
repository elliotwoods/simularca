import { describe, expect, it, vi } from "vitest";
import { DescriptorRegistry } from "@/core/hotReload/descriptorRegistry";
import { createPluginApi, type PluginDefinition } from "@/features/plugins/pluginApi";

function makePlugin(viewTypes: string[]): PluginDefinition {
  return {
    id: "plugin.example",
    name: "Example",
    actorDescriptors: [],
    componentDescriptors: [],
    viewDescriptors: viewTypes.map((viewType) => ({
      viewType,
      title: viewType
    }))
  };
}

describe("pluginViews registry", () => {
  it("registers and resolves plugin view descriptors", () => {
    const api = createPluginApi(new DescriptorRegistry(), { applyDescriptorSetUpdate: vi.fn(() => true) } as any);

    api.registerPlugin(makePlugin(["mylar.crossSection", "mylar.sweep"]));

    expect(api.getViewDescriptor("plugin.example", "mylar.crossSection")).toEqual({
      viewType: "mylar.crossSection",
      title: "mylar.crossSection"
    });
    expect(api.getViewDescriptor("plugin.example", "missing")).toBeNull();
  });

  it("rejects duplicate plugin view descriptors during handshake registration", () => {
    const api = createPluginApi(new DescriptorRegistry(), { applyDescriptorSetUpdate: vi.fn(() => true) } as any);

    expect(() => api.registerPlugin(makePlugin(["mylar.crossSection", "mylar.crossSection"]))).toThrow(
      /duplicate view descriptor/i
    );
  });
});

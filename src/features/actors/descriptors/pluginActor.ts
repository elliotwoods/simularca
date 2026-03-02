import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { PLUGIN_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface PluginRuntime {
  pluginId: string;
  entry: string;
}

export const pluginActorDescriptor: ReloadableDescriptor<PluginRuntime> = {
  id: "actor.plugin",
  kind: "actor",
  version: 1,
  schema: PLUGIN_ACTOR_SCHEMA,
  spawn: {
    actorType: "plugin",
    label: "Plugin Actor",
    description: "Generic actor type provided by plugin modules.",
    iconGlyph: "PLG",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    pluginId: typeof params.pluginId === "string" ? params.pluginId : "",
    entry: typeof params.entry === "string" ? params.entry : ""
  }),
  updateRuntime(runtime, { params }) {
    runtime.pluginId = typeof params.pluginId === "string" ? params.pluginId : runtime.pluginId;
    runtime.entry = typeof params.entry === "string" ? params.entry : runtime.entry;
  },
  status: {
    build({ actor }) {
      return [
        { label: "Type", value: "Plugin Actor" },
        { label: "Plugin Type", value: actor.pluginType ?? "n/a" },
        { label: "Plugin Id", value: typeof actor.params.pluginId === "string" ? actor.params.pluginId : "n/a" },
        { label: "Entry", value: typeof actor.params.entry === "string" ? actor.params.entry : "n/a" }
      ];
    }
  }
};

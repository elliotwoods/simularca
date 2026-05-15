import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { usePluginRegistryRevision } from "@/features/plugins/usePluginRegistryRevision";
import { isPluginEnabled } from "@/features/plugins/pluginEnabled";

export function PluginRuntimeHost() {
  const kernel = useKernel();
  usePluginRegistryRevision();
  const pluginsEnabled = useAppStore((store) => store.state.pluginsEnabled);
  const plugins = kernel.pluginApi.listPlugins();

  return (
    <>
      {plugins.map((plugin) => {
        const RuntimeComponent = plugin.definition.runtimeComponent;
        if (!RuntimeComponent) {
          return null;
        }
        if (!isPluginEnabled(pluginsEnabled, plugin.definition.id)) {
          return null;
        }
        return <RuntimeComponent key={plugin.definition.id} plugin={plugin} />;
      })}
    </>
  );
}

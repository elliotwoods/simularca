import { useKernel } from "@/app/useKernel";
import { usePluginRegistryRevision } from "@/features/plugins/usePluginRegistryRevision";

export function PluginRuntimeHost() {
  const kernel = useKernel();
  usePluginRegistryRevision();
  const plugins = kernel.pluginApi.listPlugins();

  return (
    <>
      {plugins.map((plugin) => {
        const RuntimeComponent = plugin.definition.runtimeComponent;
        if (!RuntimeComponent) {
          return null;
        }
        return <RuntimeComponent key={plugin.definition.id} plugin={plugin} />;
      })}
    </>
  );
}

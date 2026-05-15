export function isPluginEnabled(
  pluginsEnabled: Record<string, boolean>,
  pluginId: string
): boolean {
  return pluginsEnabled[pluginId] !== false;
}

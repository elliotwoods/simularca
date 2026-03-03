import type { AppKernel } from "@/app/kernel";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";
import type { LocalPluginCandidate } from "@/types/ipc";

export interface PluginDiscoveryReport {
  discovered: LocalPluginCandidate[];
  loadedCount: number;
  failed: Array<{ modulePath: string; error: string }>;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function discoverAndLoadLocalPlugins(kernel: AppKernel): Promise<PluginDiscoveryReport> {
  if (!window.electronAPI) {
    return {
      discovered: [],
      loadedCount: 0,
      failed: []
    };
  }
  const discovered = await window.electronAPI.discoverLocalPlugins();
  let loadedCount = 0;
  const failed: Array<{ modulePath: string; error: string }> = [];
  for (const candidate of discovered) {
    try {
      await loadPluginFromModule(kernel, candidate.modulePath, {
        sourceGroup: candidate.sourceGroup
      });
      loadedCount += 1;
    } catch (error) {
      failed.push({
        modulePath: candidate.modulePath,
        error: toMessage(error)
      });
    }
  }
  return {
    discovered,
    loadedCount,
    failed
  };
}


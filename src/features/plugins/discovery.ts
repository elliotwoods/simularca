import type { AppKernel } from "@/app/kernel";
import { loadPluginFromModule } from "@/features/plugins/pluginLoader";
import type { ExternalPluginCandidate } from "@/types/ipc";

export interface PluginDiscoveryReport {
  discovered: ExternalPluginCandidate[];
  addedCount: number;
  reloadedCount: number;
  failed: Array<{ modulePath: string; error: string }>;
}

export function formatPluginDiscoverySummary(report: PluginDiscoveryReport): string {
  const loadedCount = report.addedCount + report.reloadedCount;
  const base = `Discovered ${report.discovered.length}, loaded ${loadedCount} (${report.addedCount} new, ${report.reloadedCount} reloaded), failed ${report.failed.length}.`;
  const firstFailure = report.failed[0];
  if (!firstFailure) {
    return base;
  }
  return `${base} First failure: ${firstFailure.error}`;
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

export async function discoverExternalPluginCandidates(): Promise<ExternalPluginCandidate[]> {
  if (!window.electronAPI) {
    return [];
  }
  return await window.electronAPI.discoverExternalPlugins();
}

export async function loadExternalPluginCandidates(
  kernel: AppKernel,
  candidates: ExternalPluginCandidate[]
): Promise<PluginDiscoveryReport> {
  let addedCount = 0;
  let reloadedCount = 0;
  const failed: Array<{ modulePath: string; error: string }> = [];
  for (const candidate of candidates) {
    try {
      const existing = kernel.pluginApi.getPluginByModulePath(candidate.modulePath);
      await loadPluginFromModule(
        kernel,
        candidate.modulePath,
        {
          sourceGroup: candidate.sourceGroup,
          updatedAtMs: candidate.updatedAtMs,
          version: candidate.version
        },
        existing
          ? {
              cacheBustToken: candidate.updatedAtMs
            }
          : undefined
      );
      if (existing) {
        reloadedCount += 1;
      } else {
        addedCount += 1;
      }
    } catch (error) {
      const failure = {
        modulePath: candidate.modulePath,
        error: toMessage(error)
      };
      failed.push(failure);
      kernel.store.getState().actions.addLog({
        level: "warn",
        message: `Plugin load failed: ${candidate.modulePath}`,
        details: failure.error
      });
    }
  }
  return {
    discovered: candidates,
    addedCount,
    reloadedCount,
    failed
  };
}

export async function discoverAndLoadExternalPlugins(kernel: AppKernel): Promise<PluginDiscoveryReport> {
  const discovered = await discoverExternalPluginCandidates();
  return await loadExternalPluginCandidates(kernel, discovered);
}

export function startExternalPluginAutoReload(
  kernel: AppKernel,
  options: {
    intervalMs?: number;
  } = {}
): () => void {
  if (!window.electronAPI) {
    return () => {};
  }
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? 1500));
  const seenBuildTimes = new Map<string, number>();
  let disposed = false;
  let inFlight = false;

  const tick = async () => {
    if (disposed || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const candidates = await discoverExternalPluginCandidates();
      for (const candidate of candidates) {
        const previousUpdatedAtMs = seenBuildTimes.get(candidate.modulePath);
        const existing = kernel.pluginApi.getPluginByModulePath(candidate.modulePath);
        if (previousUpdatedAtMs === undefined) {
          seenBuildTimes.set(candidate.modulePath, candidate.updatedAtMs);
          if (!existing) {
            await loadExternalPluginCandidates(kernel, [candidate]);
          }
          continue;
        }
        if (candidate.updatedAtMs === previousUpdatedAtMs) {
          continue;
        }
        seenBuildTimes.set(candidate.modulePath, candidate.updatedAtMs);
        const report = await loadExternalPluginCandidates(kernel, [candidate]);
        if (report.failed.length > 0) {
          kernel.store.getState().actions.addLog({
            level: "warn",
            message: `Plugin auto-reload failed: ${candidate.modulePath}`,
            details: report.failed[0]?.error
          });
          continue;
        }
        const plugin = kernel.pluginApi.getPluginByModulePath(candidate.modulePath);
        const pluginName = plugin?.manifest?.name ?? plugin?.definition.name ?? candidate.modulePath;
        kernel.store.getState().actions.addLog({
          level: "info",
          message: `Plugin rebuilt: ${pluginName}`
        });
        kernel.store.getState().actions.setStatus(`Plugin rebuilt: ${pluginName}`);
      }
    } catch {
      // Keep dev session alive on discovery errors.
    } finally {
      inFlight = false;
    }
  };

  const intervalId = window.setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    disposed = true;
    window.clearInterval(intervalId);
  };
}

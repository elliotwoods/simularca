import { useEffect, useMemo, useState } from "react";
import { BUILD_INFO } from "@/app/buildInfo";
import type { GitDirtyBadge, GitDirtyStatusResponse } from "@/types/ipc";

const EMPTY_STATUS: GitDirtyStatusResponse = {
  app: null,
  plugins: {}
};

function shouldLoadGitDirtyStatus(): boolean {
  return Boolean(window.electronAPI) && BUILD_INFO.buildKind === "dev";
}

function uniqueSortedModulePaths(modulePaths: Array<string | null | undefined>): string[] {
  return [...new Set(modulePaths.filter((value): value is string => typeof value === "string" && value.length > 0))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function useGitDirtyStatus(modulePaths: Array<string | null | undefined>, intervalMs = 5000): GitDirtyStatusResponse {
  const [status, setStatus] = useState<GitDirtyStatusResponse>(EMPTY_STATUS);
  const normalizedModulePaths = useMemo(() => uniqueSortedModulePaths(modulePaths), [modulePaths]);
  const normalizedModulePathsKey = normalizedModulePaths.join("\n");

  useEffect(() => {
    if (!shouldLoadGitDirtyStatus()) {
      setStatus(EMPTY_STATUS);
      return;
    }
    let disposed = false;
    const load = async () => {
      try {
        const next = await window.electronAPI!.getGitDirtyStatus({
          pluginModulePaths: normalizedModulePaths
        });
        if (!disposed) {
          setStatus(next);
        }
      } catch {
        if (!disposed) {
          setStatus(EMPTY_STATUS);
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, Math.max(1000, intervalMs));

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [intervalMs, normalizedModulePathsKey]);

  return status;
}

export function getPluginGitDirtyBadge(
  status: GitDirtyStatusResponse,
  modulePath: string | null | undefined
): GitDirtyBadge | null {
  if (!modulePath) {
    return null;
  }
  return status.plugins[modulePath] ?? null;
}

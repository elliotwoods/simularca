import { useCallback, useEffect, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { FlexLayoutHost } from "@/ui/FlexLayoutHost";
import type { PublishManifest } from "@/features/publish/publishManifestSchema";
import type { PublishConfig } from "@/features/publish/publishConfigSchema";

interface ViewerAppProps {
  manifest: PublishManifest;
  publishConfig: PublishConfig;
}

/**
 * Read-only React shell for the published-snapshot viewer. Intentionally a
 * fraction of the editor `App.tsx`: no drag-import, no render export, no
 * keyboard editing shortcuts — only viewport navigation and (optionally) a
 * snapshot picker.
 */
export function ViewerApp({ manifest, publishConfig }: ViewerAppProps) {
  const kernel = useKernel();
  const activeSnapshotName = useAppStore((store) => store.state.activeSnapshotName);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (publishConfig.branding.title) {
      document.title = `${publishConfig.branding.title} — Simularca`;
    } else if (manifest.title) {
      document.title = `${manifest.title} — Simularca`;
    }
  }, [manifest.title, publishConfig.branding.title]);

  const handleSelectSnapshot = useCallback(
    async (name: string) => {
      if (name === activeSnapshotName || switching) {
        return;
      }
      setSwitching(true);
      try {
        await kernel.projectService.loadSnapshot(name);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        kernel.store.getState().actions.addLog({
          level: "error",
          message: `Failed to switch to snapshot "${name}"`,
          details: detail
        });
      } finally {
        setSwitching(false);
      }
    },
    [activeSnapshotName, kernel, switching]
  );

  const showSnapshotPicker =
    publishConfig.panels.snapshotPicker && manifest.snapshots.length > 1;

  const titleBar = (
    <div className="viewer-title-bar">
      <div className="viewer-title-bar-name">
        {publishConfig.branding.title || manifest.title || manifest.project.name}
      </div>
      {showSnapshotPicker ? (
        <label className="viewer-snapshot-picker">
          <span className="viewer-snapshot-picker-label">Snapshot</span>
          <select
            value={activeSnapshotName}
            disabled={switching}
            onChange={(event) => {
              void handleSelectSnapshot(event.target.value);
            }}
          >
            {manifest.snapshots.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );

  return (
    <div className="app-root viewer-app-root">
      <FlexLayoutHost
        titleBar={titleBar}
        topBar={null}
        profileResults={null}
        profileResultsOpen={false}
        onCloseProfileResults={() => undefined}
      />
    </div>
  );
}

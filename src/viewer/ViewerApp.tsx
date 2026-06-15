import { useCallback, useEffect, useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { FlexLayoutHost } from "@/ui/FlexLayoutHost";
import { TitleBarBrand } from "@/ui/components/TitleBarBrand";
import { TopBarPanel } from "@/ui/panels/TopBarPanel";
import type { PublishManifest } from "@/features/publish/publishManifestSchema";
import type { PublishConfig } from "@/features/publish/publishConfigSchema";

interface ViewerAppProps {
  manifest: PublishManifest;
  publishConfig: PublishConfig;
}

/**
 * Read-only React shell for the published-snapshot viewer. Intentionally a
 * fraction of the editor `App.tsx`: no drag-import, no render export, no
 * keyboard editing shortcuts — only viewport navigation, an optional snapshot
 * picker, and a curated toolbar.
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

  const header = publishConfig.header;
  const canEdit = publishConfig.permissions.canEditParameters;
  const projectLabel = publishConfig.branding.title || manifest.title || manifest.project.name;
  const showSnapshotPicker =
    publishConfig.panels.snapshotPicker && manifest.snapshots.length > 1;

  const titleBar = header.showTitleBar ? (
    <div className="viewer-title-bar">
      <div className="viewer-title-bar-brand">
        <TitleBarBrand compact />
      </div>
      <div className="viewer-title-bar-center">
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
      <div className="viewer-title-bar-name" title={projectLabel}>
        {projectLabel}
      </div>
    </div>
  ) : null;

  // Materials/Edit affordances are only meaningful when the matching viewer
  // permissions are granted; force them off otherwise so a publisher's stale
  // toggle can't expose mutation paths.
  const toolbarVisibility = {
    camera: header.toolbar.camera,
    time: header.toolbar.time,
    fps: header.toolbar.fps,
    edit: header.toolbar.edit && canEdit,
    materials: header.toolbar.materials && canEdit,
    keyboard: header.toolbar.keyboard,
    render: false,
    profile: false
  };

  const anyToolbarSection =
    toolbarVisibility.camera ||
    toolbarVisibility.time ||
    toolbarVisibility.fps ||
    toolbarVisibility.edit ||
    toolbarVisibility.materials ||
    toolbarVisibility.keyboard;

  const topBar =
    header.showToolbar && anyToolbarSection ? (
      <TopBarPanel
        onToggleKeyboardMap={() => undefined}
        onOpenRender={() => undefined}
        onOpenPrint={() => undefined}
        onCaptureViewportScreenshot={() => undefined}
        canCaptureViewportScreenshot={false}
        viewportScreenshotBusy={false}
        onOpenProfiling={() => undefined}
        profilingState={{
          phase: "idle",
          requestedFrameCount: 0,
          capturedFrameCount: 0,
          pendingGpuFrames: 0,
          options: null,
          result: null
        }}
        requestTextInput={async () => null}
        visibility={toolbarVisibility}
      />
    ) : null;

  return (
    <div className="app-root viewer-app-root">
      <FlexLayoutHost
        titleBar={titleBar}
        topBar={topBar}
        profileResults={null}
        profileResultsOpen={false}
        onCloseProfileResults={() => undefined}
      />
    </div>
  );
}

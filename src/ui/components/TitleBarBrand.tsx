import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo } from "@fortawesome/free-solid-svg-icons";
import { BUILD_INFO, formatBuildTimestamp } from "@/app/buildInfo";
import { AboutModal } from "@/ui/components/AboutModal";
import { GitDirtyBadge } from "@/ui/components/GitDirtyBadge";
import { useGitDirtyStatus } from "@/ui/useGitDirtyStatus";
import appIconUrl from "../../../icon.png";

const APP_NAME = "Simularca";

interface TitleBarBrandProps {
  /** When true, show a git-dirty indicator next to the build meta. */
  showDirtyBadge?: boolean;
  /** Hide the trailing commit/build timestamp on tighter layouts. */
  compact?: boolean;
}

export function TitleBarBrand({ showDirtyBadge = false, compact = false }: TitleBarBrandProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const gitDirtyStatus = useGitDirtyStatus([]);
  const buildMeta = `${BUILD_INFO.commitShortSha || "unknown"} | ${formatBuildTimestamp(BUILD_INFO.buildTimestampIso)}`;

  return (
    <>
      <div className="titlebar-app-icon" aria-hidden="true">
        <img src={appIconUrl} alt="" />
      </div>
      <button
        type="button"
        className="titlebar-brand-button"
        title={BUILD_INFO.commitSubject}
        onClick={() => setAboutOpen(true)}
      >
        <div className="titlebar-brand">
          <strong>{APP_NAME}</strong>
          <span>v{BUILD_INFO.version}</span>
          {compact ? null : (
            <span className="titlebar-build-meta">
              {buildMeta}
              {showDirtyBadge ? (
                <GitDirtyBadge
                  count={gitDirtyStatus.app?.changedFileCount ?? 0}
                  className="git-dirty-badge titlebar-git-dirty-badge"
                />
              ) : null}
            </span>
          )}
        </div>
        <FontAwesomeIcon icon={faCircleInfo} />
      </button>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}

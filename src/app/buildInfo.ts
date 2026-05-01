import type { BuildInfo } from "@/app/buildVersion";

export const FALLBACK_BUILD_INFO: BuildInfo = {
  version: "0.0.0",
  baseVersion: "0.0.0",
  commitsSinceAnchor: 0,
  buildKind: "dev",
  buildTimestampIso: "",
  commitSha: "",
  commitShortSha: "",
  commitSubject: "Build metadata unavailable"
};

export const BUILD_INFO: BuildInfo =
  typeof __SIMULARCA_BUILD_INFO__ === "object" && __SIMULARCA_BUILD_INFO__ !== null
    ? __SIMULARCA_BUILD_INFO__
    : FALLBACK_BUILD_INFO;

export function buildInfoSummary(buildInfo: BuildInfo): string {
  const subject = buildInfo.commitSubject?.trim() || "No commit subject";
  const shortSha = buildInfo.commitShortSha?.trim();
  return shortSha
    ? `Simularca v${buildInfo.version} (${shortSha}) - ${subject}`
    : `Simularca v${buildInfo.version} - ${subject}`;
}

export function formatBuildTimestamp(iso: string): string {
  if (!iso) {
    return "Unknown";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

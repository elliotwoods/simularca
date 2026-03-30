import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function parseSemVer(input) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(input).trim());
  if (!match) {
    throw new Error(`Invalid semantic version "${input}". Expected major.minor.patch.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function formatSemVer(version) {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

export function computeDerivedVersion(baseVersion, commitsSinceAnchor, buildKind) {
  const parsed = parseSemVer(baseVersion);
  const safeCommits = Number.isFinite(commitsSinceAnchor) ? Math.max(0, Math.floor(commitsSinceAnchor)) : 0;
  const buildOffset = buildKind === "build" ? 1 : 0;
  return formatSemVer({
    ...parsed,
    patch: parsed.patch + safeCommits + buildOffset
  });
}

export function loadVersionBaseline(baselinePath) {
  const raw = readFileSync(baselinePath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.baseVersion !== "string" || parsed.baseVersion.trim().length === 0) {
    throw new Error(`Missing or invalid baseVersion in ${path.basename(baselinePath)}.`);
  }
  if (typeof parsed.anchorCommit !== "string" || parsed.anchorCommit.trim().length === 0) {
    throw new Error(`Missing or invalid anchorCommit in ${path.basename(baselinePath)}.`);
  }
  return {
    baseVersion: parsed.baseVersion.trim(),
    anchorCommit: parsed.anchorCommit.trim()
  };
}

export function validateAnchorCommit(gitRoot, anchorCommit) {
  runGit(["cat-file", "-e", `${anchorCommit}^{commit}`], gitRoot);
  runGit(["merge-base", "--is-ancestor", anchorCommit, "HEAD"], gitRoot);
}

export function findGitRoot(startPath) {
  return runGit(["rev-parse", "--show-toplevel"], startPath);
}

export function computeScopedCommitCount(gitRoot, anchorCommit, scopePath) {
  const normalizedScope = scopePath.split(path.sep).join("/") || ".";
  const count = Number.parseInt(runGit(["rev-list", "--count", `${anchorCommit}..HEAD`, "--", normalizedScope], gitRoot), 10);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`Unable to calculate commit count for ${normalizedScope}.`);
  }
  return count;
}

export function buildInfoFromGit({ gitRoot, baseline, buildKind, scopePath }) {
  validateAnchorCommit(gitRoot, baseline.anchorCommit);
  const commitsSinceAnchor = computeScopedCommitCount(gitRoot, baseline.anchorCommit, scopePath);
  return {
    version: computeDerivedVersion(baseline.baseVersion, commitsSinceAnchor, buildKind),
    baseVersion: baseline.baseVersion,
    commitsSinceAnchor,
    buildKind,
    buildTimestampIso: new Date().toISOString(),
    commitSha: runGit(["rev-parse", "HEAD"], gitRoot),
    commitShortSha: runGit(["rev-parse", "--short=8", "HEAD"], gitRoot),
    commitSubject: runGit(["log", "-1", "--pretty=%s"], gitRoot)
  };
}

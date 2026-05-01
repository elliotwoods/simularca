import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInfoFromGit, loadVersionBaseline } from "./versioning.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "version-baseline.json");
const outputPath = path.join(repoRoot, ".simularca-build-info.json");

function resolveBuildKind() {
  const input = process.argv[2];
  if (input === "dev" || input === "build") {
    return input;
  }
  throw new Error(`Expected build kind "dev" or "build"; received "${input ?? ""}".`);
}

function main() {
  const buildKind = resolveBuildKind();
  const baseline = loadVersionBaseline(baselinePath);
  const buildInfo = buildInfoFromGit({
    gitRoot: repoRoot,
    baseline,
    buildKind,
    scopePath: "."
  });

  writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
  console.log(`Build info written: v${buildInfo.version} (${buildInfo.buildKind}) ${buildInfo.commitShortSha}`);
}

main();

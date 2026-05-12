// Sanity test: run the format validator (no network) against the user's
// real saved publish-settings.json and a synthetic happy-path target. Lets
// us confirm the validator catches the known accountId issue without needing
// a running Electron instance.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronDistRoot = join(here, "..", "dist-electron", "electron");
const verifyModuleUrl = pathToFileURL(join(electronDistRoot, "publishVerify.js")).href;

const { verifyTarget } = await import(verifyModuleUrl);

const realSettings = JSON.parse(
  readFileSync(
    process.env.APPDATA + "/Simularca/publish-settings.json",
    "utf8"
  )
);
const realTarget = realSettings.targets[0];

console.log("=== User's saved target ===");
const realResult = await verifyTarget({ target: realTarget, skipNetwork: true });
console.log(`ok: ${realResult.ok}`);
for (const issue of realResult.issues) {
  console.log(`  [${issue.severity.toUpperCase()}] ${issue.field}: ${issue.message}`);
}

console.log("\n=== Hypothetical valid target (sync only) ===");
const happyTarget = {
  id: "happy",
  label: "Production",
  r2: {
    accountId: "1234567890abcdef1234567890abcdef",
    accessKeyId: "abcdef1234567890abcdef1234567890",
    secretAccessKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    bucket: "simularca-projects"
  },
  bucketBaseUrl: "https://pub-abc1234567890abc1234567890abc123.r2.dev",
  viewerUrl: "https://simularca-viewer.vercel.app"
};
const happyResult = await verifyTarget({ target: happyTarget, skipNetwork: true });
console.log(`ok: ${happyResult.ok}`);
for (const issue of happyResult.issues) {
  console.log(`  [${issue.severity.toUpperCase()}] ${issue.field}: ${issue.message}`);
}

console.log("\n=== Various bad inputs ===");
const badInputs = [
  {
    name: "UUID account id",
    accountId: "0aaa84f5-3ee3-4d61-ab96-04910cb5d610",
    bucket: "good-bucket"
  },
  {
    name: "bucket name in account id",
    accountId: "simularca-projects",
    bucket: "simularca-projects"
  },
  {
    name: "uppercase bucket",
    accountId: "1234567890abcdef1234567890abcdef",
    bucket: "Simularca-Projects"
  },
  {
    name: "bucket too short",
    accountId: "1234567890abcdef1234567890abcdef",
    bucket: "ab"
  },
  {
    name: "consecutive hyphens",
    accountId: "1234567890abcdef1234567890abcdef",
    bucket: "foo--bar"
  }
];
for (const bad of badInputs) {
  const draft = {
    id: "x",
    label: "X",
    r2: {
      accountId: bad.accountId,
      accessKeyId: "abcdef1234567890abcdef1234567890",
      secretAccessKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      bucket: bad.bucket
    },
    bucketBaseUrl: "https://pub-abc1234567890abc1234567890abc123.r2.dev",
    viewerUrl: "https://simularca-viewer.vercel.app"
  };
  const result = await verifyTarget({ target: draft, skipNetwork: true });
  console.log(`-- ${bad.name}: ok=${result.ok}`);
  for (const issue of result.issues) {
    if (issue.severity === "error") {
      console.log(`     [ERR] ${issue.field}: ${issue.message}`);
    }
  }
}

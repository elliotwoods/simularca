import { readFileSync } from "node:fs";
import { z } from "zod";

const publishConfigSchema = z.object({
  configVersion: z.literal(1),
  panels: z.object({
    sceneTree: z.boolean(),
    inspector: z.boolean(),
    console: z.boolean(),
    snapshotPicker: z.boolean()
  }),
  interactions: z.object({
    transformGizmo: z.boolean(),
    axisWidget: z.boolean(),
    viewPresets: z.boolean(),
    postProcessing: z.boolean(),
    orbitPanZoom: z.boolean()
  }),
  branding: z.object({ title: z.string().optional() })
});

const publishManifestSchema = z.object({
  manifestVersion: z.literal(1),
  publishId: z.string().min(1),
  title: z.string(),
  publishedAtIso: z.string(),
  requiredViewerSha: z.string().min(1),
  appBuild: z.object({ version: z.string(), commitShortSha: z.string() }),
  project: z.object({ uuid: z.string().uuid(), name: z.string() }),
  snapshots: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().min(1),
        schemaVersion: z.number().int().nonnegative(),
        default: z.boolean().optional()
      })
    )
    .min(1),
  assets: z.record(z.string(), z.string()),
  plugins: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string(),
      url: z.string().min(1),
      core: z.boolean(),
      externals: z.record(z.string(), z.string())
    })
  ),
  publishConfigUrl: z.string().min(1)
});

const payload = JSON.parse(readFileSync("public/dev-publish/payload.json", "utf8"));
console.log("payload.bucketBaseUrl:", payload.bucketBaseUrl);
const manifest = publishManifestSchema.parse(payload.manifest);
console.log(
  "manifest OK; publishId =",
  manifest.publishId,
  "snapshots =",
  manifest.snapshots.length,
  "assets =",
  Object.keys(manifest.assets).length
);
const config = publishConfigSchema.parse(payload.publishConfig);
console.log("publishConfig OK; panels =", JSON.stringify(config.panels));

const latest = JSON.parse(
  readFileSync("public/dev-publish/publishes/dev-smoke-test/latest.json", "utf8")
);
console.log("latest.json:", JSON.stringify(latest));

const manifestStandalone = publishManifestSchema.parse(
  JSON.parse(
    readFileSync(`public/dev-publish/publishes/dev-smoke-test/${latest.manifestUrl}`, "utf8")
  )
);
console.log("standalone manifest OK; matches:", manifestStandalone.publishId === manifest.publishId);

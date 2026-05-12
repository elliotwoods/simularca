import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { BuildInfo } from "./src/app/buildVersion";

const GENERATED_BUILD_INFO_PATH = path.resolve(__dirname, ".simularca-build-info.json");

function loadBuildInfo(): BuildInfo {
  try {
    const raw = fs.readFileSync(GENERATED_BUILD_INFO_PATH, "utf8");
    return JSON.parse(raw) as BuildInfo;
  } catch {
    return {
      version: "0.0.0",
      baseVersion: "0.0.0",
      commitsSinceAnchor: 0,
      buildKind: "dev",
      buildTimestampIso: "",
      commitSha: "",
      commitShortSha: "",
      commitSubject: "Build metadata unavailable"
    };
  }
}

const VIEWER_EXTERNALS_PATH = path.resolve(__dirname, "viewer-externals.json");

function loadViewerExternals(): Record<string, string> {
  try {
    const raw = fs.readFileSync(VIEWER_EXTERNALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { externals?: Record<string, string> };
    return parsed.externals ?? {};
  } catch {
    return {};
  }
}

// `viewer.html` is the published-snapshot read-only viewer (see Phase 1 of the
// publish-to-web plan). It must NOT pull in editor-only modules. The split
// here also lets us disable sourcemaps for the viewer prod bundle without
// affecting the editor build.
//
// Mode `viewer-production` drops the editor entry so the publicly-deployed
// bundle ships ONLY the viewer code. `scripts/build-viewer.mjs` is the
// canonical entry for that path; it also versions the output under
// `dist/v/<sha>/`.
export default defineConfig(({ mode }) => {
  const viewerOnly = mode === "viewer-production";
  const input: Record<string, string> = viewerOnly
    ? { viewer: path.resolve(__dirname, "viewer.html") }
    : {
        editor: path.resolve(__dirname, "index.html"),
        viewer: path.resolve(__dirname, "viewer.html")
      };
  return {
    plugins: [react()],
    define: {
      __SIMULARCA_BUILD_INFO__: JSON.stringify(loadBuildInfo()),
      __SIMULARCA_VIEWER_EXTERNALS__: JSON.stringify(loadViewerExternals())
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src")
      },
      dedupe: ["three"]
    },
    build: {
      // Editor needs sourcemaps for live debug bridge. Viewer is published to
      // a public bucket; source maps would defeat the obfuscation tier of the
      // anti-rip stance. The viewer-specific build script
      // (`scripts/build-viewer.mjs`) overrides this back to false.
      sourcemap: !viewerOnly,
      rollupOptions: { input }
    }
  };
});

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

export default defineConfig({
  plugins: [react()],
  define: {
    __SIMULARCA_BUILD_INFO__: JSON.stringify(loadBuildInfo())
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  build: {
    sourcemap: true
  }
});

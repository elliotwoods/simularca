import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "logs", "codex-debug-session.json");

function usage() {
  return [
    "Usage:",
    "  node scripts/debug-session.mjs health",
    "  node scripts/debug-session.mjs windows",
    "  node scripts/debug-session.mjs logs [tail]",
    '  node scripts/debug-session.mjs renderer --console "scene.stats()" [--window 1]',
    '  node scripts/debug-session.mjs renderer --eval "document.pointerLockElement"',
    '  node scripts/debug-session.mjs main "BrowserWindow.getAllWindows().map((w) => w.id)"'
  ].join("\n");
}

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Live debug manifest not found or unreadable at ${manifestPath}: ${message}`);
  }
}

async function requestJson(manifest, pathname, init = {}) {
  const response = await fetch(`${manifest.baseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${manifest.token}`,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function parseWindowId(args) {
  const index = args.indexOf("--window");
  if (index === -1) {
    return undefined;
  }
  const value = Number(args[index + 1] ?? "");
  if (!Number.isFinite(value)) {
    throw new Error("--window requires a numeric window id.");
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error(usage());
  }
  const manifest = await readManifest();
  const command = args[0];

  if (command === "health") {
    console.log(JSON.stringify(await requestJson(manifest, "/health"), null, 2));
    return;
  }
  if (command === "windows") {
    console.log(JSON.stringify(await requestJson(manifest, "/windows"), null, 2));
    return;
  }
  if (command === "logs") {
    const tail = Number(args[1] ?? "200");
    console.log(JSON.stringify(await requestJson(manifest, `/logs/runtime?tail=${String(Number.isFinite(tail) ? tail : 200)}`), null, 2));
    return;
  }
  if (command === "renderer") {
    const mode = args[1];
    if (mode !== "--console" && mode !== "--eval") {
      throw new Error(usage());
    }
    const source = args[2];
    if (!source) {
      throw new Error("Renderer commands require source code.");
    }
    const windowId = parseWindowId(args.slice(3));
    console.log(
      JSON.stringify(
        await requestJson(manifest, "/renderer/execute", {
          method: "POST",
          body: JSON.stringify({
            source,
            mode: mode === "--eval" ? "eval" : "console",
            windowId
          })
        }),
        null,
        2
      )
    );
    return;
  }
  if (command === "main") {
    const source = args[1];
    if (!source) {
      throw new Error("Main commands require source code.");
    }
    console.log(
      JSON.stringify(
        await requestJson(manifest, "/main/execute", {
          method: "POST",
          body: JSON.stringify({ source })
        }),
        null,
        2
      )
    );
    return;
  }
  throw new Error(usage());
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

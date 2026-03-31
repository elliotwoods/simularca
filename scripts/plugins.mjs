import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const mode = process.argv[2] === "watch" ? "watch" : "build";
const rootNames = ["plugins", "plugins-external"];
const npmCliPath = process.env.npm_execpath ?? null;
const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";

async function directoryExists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function discoverPluginPackages() {
  const packages = [];
  for (const rootName of rootNames) {
    const rootPath = path.join(repoRoot, rootName);
    if (!(await directoryExists(rootPath))) {
      continue;
    }
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = path.join(rootPath, entry.name);
      const packageJsonPath = path.join(packagePath, "package.json");
      if (!(await fileExists(packageJsonPath))) {
        continue;
      }
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      packages.push({
        name: `${rootName}/${entry.name}`,
        path: packagePath,
        scripts: packageJson.scripts ?? {}
      });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

function isTsWatchBoilerplate(line) {
  return (
    /Starting compilation in watch mode/.test(line) ||
    /File change detected\. Starting incremental compilation/.test(line)
  );
}

function summarizeTsWatchLine(line) {
  const foundErrorsMatch = line.match(/Found (\d+) errors?\. Watching for file changes\./);
  if (foundErrorsMatch) {
    const errorCount = Number(foundErrorsMatch[1] ?? "0");
    return errorCount === 0 ? "ready" : `watching with ${errorCount} error${errorCount === 1 ? "" : "s"}`;
  }
  const foundErrorsOnlyMatch = line.match(/Found (\d+) errors?\./);
  if (foundErrorsOnlyMatch) {
    const errorCount = Number(foundErrorsOnlyMatch[1] ?? "0");
    return `${errorCount} error${errorCount === 1 ? "" : "s"}`;
  }
  return null;
}

function attachWatchLogging(pluginPackage, child) {
  const attach = (stream, method) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        if (isTsWatchBoilerplate(line)) {
          continue;
        }
        const summary = summarizeTsWatchLine(line);
        if (summary) {
          console.log(`[plugins] ${pluginPackage.name}: ${summary}`);
          continue;
        }
        method(`[plugins:${pluginPackage.name}] ${line}`);
      }
    });
  };
  attach(child.stdout, console.log);
  attach(child.stderr, console.error);
}

function createDirectNodeSpec(pluginPackage, scriptCommand, extraArgs = []) {
  const trimmed = typeof scriptCommand === "string" ? scriptCommand.trim() : "";
  const match = /^node\s+(.+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const scriptPath = match[1]?.trim();
  if (!scriptPath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [path.resolve(pluginPackage.path, scriptPath), ...extraArgs],
    restartOnExit: false
  };
}

function createCommandForPackage(pluginPackage) {
  const runNpm = (...npmArgs) => {
    if (npmCliPath) {
      return { command: process.execPath, args: [npmCliPath, ...npmArgs], restartOnExit: false };
    }
    return { command: npmBinary, args: npmArgs, restartOnExit: false };
  };
  if (!npmCliPath && mode === "build") {
    // Direct invocation fallback, mainly for debugging outside `npm run`.
  }
  if (mode === "watch") {
    if (typeof pluginPackage.scripts.dev === "string") {
      const direct = createDirectNodeSpec(pluginPackage, pluginPackage.scripts.dev);
      if (direct) {
        return direct;
      }
      return runNpm("--silent", "run", "dev");
    }
    if (typeof pluginPackage.scripts.watch === "string") {
      const direct = createDirectNodeSpec(pluginPackage, pluginPackage.scripts.watch);
      if (direct) {
        return direct;
      }
      return runNpm("--silent", "run", "watch");
    }
    if (typeof pluginPackage.scripts.build === "string") {
      const direct = createDirectNodeSpec(pluginPackage, pluginPackage.scripts.build, ["--watch", "--pretty", "false"]);
      if (direct) {
        return direct;
      }
      return runNpm("--silent", "run", "build", "--", "--watch", "--pretty", "false");
    }
    return null;
  }
  if (typeof pluginPackage.scripts.build === "string") {
    const direct = createDirectNodeSpec(pluginPackage, pluginPackage.scripts.build);
    if (direct) {
      return direct;
    }
    return runNpm("--silent", "run", "build");
  }
  return null;
}

async function runBuildMode(packages) {
  for (const pluginPackage of packages) {
    const spec = createCommandForPackage(pluginPackage);
    if (!spec) {
      continue;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: pluginPackage.path,
        stdio: "inherit",
        shell: false
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Plugin build failed for ${pluginPackage.name} with exit code ${String(code)}.`));
      });
    });
  }
}

async function runWatchMode(packages) {
  if (packages.length === 0) {
    console.log("[plugins] No plugin packages found to watch.");
  }
  const children = [];
  const closeChildren = () => {
    for (const child of children) {
      if (!child.killed) {
        child.kill();
      }
    }
  };
  process.on("SIGINT", () => {
    closeChildren();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeChildren();
    process.exit(0);
  });

  for (const pluginPackage of packages) {
    const spec = createCommandForPackage(pluginPackage);
    if (!spec) {
      console.log(`[plugins] Skipping ${pluginPackage.name}: no build/dev/watch script.`);
      continue;
    }
    console.log(`[plugins] Watching ${pluginPackage.name}`);
    const child = spawn(spec.command, spec.args, {
      cwd: pluginPackage.path,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    attachWatchLogging(pluginPackage, child);
    child.on("exit", (code, signal) => {
      if (signal) {
        console.log(`[plugins] ${pluginPackage.name} watcher stopped (${signal}).`);
        return;
      }
      console.log(`[plugins] ${pluginPackage.name} watcher exited with code ${String(code)}.`);
    });
    children.push(child);
  }

  await new Promise(() => {});
}

const packages = await discoverPluginPackages();
if (mode === "build") {
  await runBuildMode(packages);
} else {
  await runWatchMode(packages);
}

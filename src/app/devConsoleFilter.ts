import { toCompactYaml } from "@/core/console/consoleUtils";

const SUPPRESSED_DEV_CONSOLE_PREFIXES = [
  "Download the React DevTools for a better development experience:"
] as const;

const LOG_LEVEL_COLORS = {
  log: "color: #888",
  info: "color: #0cf",
  warn: "color: #f90",
  error: "color: #f33",
  debug: "color: #999"
} as const;

export function shouldSuppressDevConsoleMessage(args: unknown[]): boolean {
  const [firstArg] = args;
  if (typeof firstArg !== "string") {
    return false;
  }
  return SUPPRESSED_DEV_CONSOLE_PREFIXES.some((prefix) => firstArg.startsWith(prefix));
}

export function installDevConsoleFilter(): void {
  const methods: Array<"log" | "info" | "warn" | "error" | "debug"> = ["log", "info", "warn", "error", "debug"];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (shouldSuppressDevConsoleMessage(args)) {
        return;
      }
      
      const parts = args.map((arg) => {
        if (typeof arg === "object" && arg !== null) {
          return toCompactYaml(arg).trim();
        }
        return String(arg);
      });
      
      const label = method.toUpperCase();
      const style = LOG_LEVEL_COLORS[method] || "";
      
      // We log the formatted string. 
      // Note: This replaces the original object logging, which makes it 
      // much more readable in the Electron terminal/log files.
      original(`%c${label}%c ${parts.join(" ")}`, style, "");
    };
  }
}

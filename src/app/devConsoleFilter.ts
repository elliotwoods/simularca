const SUPPRESSED_DEV_CONSOLE_PREFIXES = [
  "Download the React DevTools for a better development experience:"
] as const;

export function shouldSuppressDevConsoleMessage(args: unknown[]): boolean {
  const [firstArg] = args;
  if (typeof firstArg !== "string") {
    return false;
  }
  return SUPPRESSED_DEV_CONSOLE_PREFIXES.some((prefix) => firstArg.startsWith(prefix));
}

export function installDevConsoleFilter(): void {
  const methods: Array<"log" | "info" | "warn"> = ["log", "info", "warn"];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (shouldSuppressDevConsoleMessage(args)) {
        return;
      }
      original(...args);
    };
  }
}

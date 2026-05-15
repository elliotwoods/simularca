
export function toCompactYaml(val: unknown, depth = 0): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") {
    if (val.includes("\n")) {
      const indent = "  ".repeat(depth + 1);
      return `|\n${indent}${val.replace(/\n/g, `\n${indent}`)}`;
    }
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;

  const indent = "  ".repeat(depth);
  
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    const isSimple = val.length <= 10 && val.every(v => v === null || typeof v !== "object");
    if (isSimple) {
      return `[${val.map(v => toCompactYaml(v)).join(", ")}]`;
    }
    return val.map(v => `\n${indent}- ${toCompactYaml(v, depth + 1)}`).join("");
  }

  if (val instanceof Error) {
    const errorObj: Record<string, unknown> = {
      name: val.name,
      message: val.message,
    };
    if (val.stack) {
      errorObj.stack = val.stack;
    }
    return toCompactYaml(errorObj, depth);
  }

  const keys = Object.keys(val as object);
  if (keys.length === 0) return "{}";

  const isSimple = depth > 0 && keys.length <= 3 && keys.every(k => {
    const v = (val as any)[k];
    return v === null || (typeof v !== "object" && typeof v !== "function");
  });
  
  if (isSimple) {
    return `{ ${keys.map(k => `${k}: ${toCompactYaml((val as any)[k])}`).join(", ")} }`;
  }

  return keys.map(key => {
    const v = (val as any)[key];
    const isComplex = typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
    const formatted = toCompactYaml(v, depth + 1);
    const separator = isComplex ? "" : " ";
    return `\n${indent}${key}:${separator}${formatted}`;
  }).join("");
}

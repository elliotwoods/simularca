import type { ElectronApi } from "@/types/ipc";

export function resolveDroppedFileSourcePath(
  file: File | null | undefined,
  electronApi?: Pick<ElectronApi, "getPathForFile"> | undefined
): string | null {
  if (!file) {
    return null;
  }
  const electronPath = electronApi?.getPathForFile(file);
  if (typeof electronPath === "string" && electronPath.trim().length > 0) {
    return electronPath;
  }
  const legacyPath = (file as File & { path?: unknown }).path;
  if (typeof legacyPath === "string" && legacyPath.trim().length > 0) {
    return legacyPath;
  }
  return null;
}

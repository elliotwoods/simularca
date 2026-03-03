import type { AppState, SessionManifest } from "@/core/types";
import { buildSessionManifest } from "@/core/session/sessionManifest";
import { serializeSession } from "@/core/session/sessionSchema";

export function estimateSessionPayloadBytes(state: AppState, mode: SessionManifest["appMode"]): number {
  const payload = serializeSession(buildSessionManifest(state, mode));
  return new Blob([payload]).size;
}

import type { StorageAdapter } from "./storageAdapter";
import { createElectronStorageAdapter } from "./electronStorageAdapter";
import { createWebStorageAdapter, type WebStorageAdapterOptions } from "./webStorageAdapter";

/**
 * Builds the appropriate `StorageAdapter` for the current runtime.
 *
 * - When `webOptions` is provided (the published-snapshot viewer entry), the
 *   web adapter is forced regardless of `window.electronAPI` so the viewer
 *   build can be smoke-tested inside Electron during development.
 * - In Electron without `webOptions`, the Electron adapter is returned.
 * - In a plain browser without `webOptions`, the web adapter is created
 *   without a manifest. This branch should only be hit by code paths that
 *   never read project data (e.g. early bootstrap before the manifest has
 *   loaded). Such adapters will throw on every read attempt.
 */
export function createStorageAdapter(webOptions?: WebStorageAdapterOptions): StorageAdapter {
  if (webOptions) {
    return createWebStorageAdapter(webOptions);
  }
  if (window.electronAPI) {
    return createElectronStorageAdapter();
  }
  // Plain-browser fallback: legitimate usage is the editor entry being
  // accidentally loaded in a browser tab. Throwing makes the failure obvious.
  throw new Error(
    "Web build entry was reached without a publish manifest. The editor build must run inside Electron; the viewer build must supply WebStorageAdapterOptions."
  );
}

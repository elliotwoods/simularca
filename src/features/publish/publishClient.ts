import type {
  DeployViewerProgressEvent,
  ListedPublish,
  PublishApi,
  PublishCheckViewerVersionRequest,
  PublishCheckViewerVersionResult,
  PublishDeleteResult,
  PublishProgressEvent,
  PublishRollbackRequest,
  PublishStartAck,
  PublishStartRequest,
  PublishTargetWriteRequest,
  RedactedPublishSettings,
  VercelSettingsWriteRequest,
  VercelTokenVerifyResult,
  VerifyTargetResult
} from "@/types/ipc";

/**
 * Renderer-side facade around `window.electronAPI.publish`. Mirrors the shape
 * of `electronStorageAdapter.ts` — pure passthrough plus a friendly error
 * when called from the web (viewer) build, where `electronAPI` is undefined.
 */

function api(): PublishApi {
  const electron = window.electronAPI;
  if (!electron) {
    throw new Error(
      "publishClient: window.electronAPI is unavailable. The publish flow only runs in the Electron editor."
    );
  }
  return electron.publish;
}

export async function loadPublishSettings(): Promise<RedactedPublishSettings> {
  return api().loadSettings();
}

export async function savePublishSettings(args: {
  targets: PublishTargetWriteRequest[];
  defaultTargetId?: string;
}): Promise<RedactedPublishSettings> {
  return api().saveSettings(args);
}

export async function listPublishesForProject(projectUuid: string): Promise<ListedPublish[]> {
  return api().listForProject({ projectUuid });
}

export async function checkViewerVersion(
  args: PublishCheckViewerVersionRequest
): Promise<PublishCheckViewerVersionResult> {
  return api().checkViewerVersion(args);
}

export async function verifyPublishTarget(args: {
  draft: PublishTargetWriteRequest;
  skipNetwork?: boolean;
}): Promise<VerifyTargetResult> {
  return api().verifyTarget(args);
}

export async function startPublish(args: PublishStartRequest): Promise<PublishStartAck> {
  return api().start(args);
}

export async function cancelPublish(jobId: string): Promise<void> {
  return api().cancel({ jobId });
}

export async function rollbackPublish(args: PublishRollbackRequest): Promise<void> {
  return api().rollback(args);
}

export async function deletePublish(args: {
  targetId: string;
  publishId: string;
}): Promise<PublishDeleteResult> {
  return api().deletePublish(args);
}

export function subscribePublishProgress(
  listener: (event: PublishProgressEvent) => void
): () => void {
  return api().onProgress(listener);
}

export async function openVercelTokensPage(): Promise<void> {
  return api().openVercelTokens();
}

export async function openExternalUrl(url: string): Promise<void> {
  return api().openExternal(url);
}

export async function verifyVercelToken(args: {
  token: string;
  teamId?: string;
}): Promise<VercelTokenVerifyResult> {
  return api().verifyVercelToken(args);
}

export async function saveVercelSettings(
  args: VercelSettingsWriteRequest
): Promise<RedactedPublishSettings> {
  return api().saveVercelSettings(args);
}

export async function deployViewerToVercel(): Promise<{ jobId: string }> {
  return api().deployViewer();
}

export function subscribeViewerDeployProgress(
  listener: (event: DeployViewerProgressEvent) => void
): () => void {
  return api().onViewerDeployProgress(listener);
}

export async function setDefaultPublishLayout(
  layout: unknown | null
): Promise<RedactedPublishSettings> {
  return api().setDefaultLayout({ layout });
}

export async function setDefaultViewerPermissions(
  permissions: unknown | null
): Promise<RedactedPublishSettings> {
  return api().setDefaultPermissions({ permissions });
}

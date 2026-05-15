import { useEffect, useMemo, useState } from "react";
import {
  loadPublishSettings,
  openVercelTokensPage,
  saveVercelSettings,
  verifyVercelToken
} from "@/features/publish/publishClient";
import type { RedactedPublishSettings, VercelTokenVerifyResult } from "@/types/ipc";

interface VercelSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: RedactedPublishSettings) => void;
}

interface DraftState {
  token: string;
  teamId: string;
  projectName: string;
  hasSavedToken: boolean;
  savedAccountLabel?: string;
  savedTeamId?: string;
  savedProjectName?: string;
}

function emptyDraft(): DraftState {
  return {
    token: "",
    teamId: "",
    projectName: "simularca-viewer",
    hasSavedToken: false
  };
}

export function VercelSettingsModal(props: VercelSettingsModalProps) {
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft());
  const [loading, setLoading] = useState(true);
  const [verifyResult, setVerifyResult] = useState<VercelTokenVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setError(null);
    setVerifyResult(null);
    setLoading(true);
    loadPublishSettings()
      .then((settings) => {
        const viewer = settings.viewerDeployment;
        setDraft({
          token: "",
          teamId: viewer?.vercelTeamId ?? "",
          projectName: viewer?.vercelProjectName ?? "simularca-viewer",
          hasSavedToken: Boolean(viewer?.hasVercelToken),
          savedAccountLabel: viewer?.cachedAccountLabel,
          savedTeamId: viewer?.vercelTeamId,
          savedProjectName: viewer?.vercelProjectName
        });
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, [props.open]);

  const handleVerify = async (): Promise<void> => {
    if (!draft.token.trim()) {
      setVerifyResult({ ok: false, error: "Paste a Vercel token first." });
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyVercelToken({
        token: draft.token,
        teamId: draft.teamId.trim() || undefined
      });
      setVerifyResult(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const next = await saveVercelSettings({
        token: draft.token.trim() || undefined,
        projectName: draft.projectName.trim() || undefined,
        teamId: draft.teamId.trim() || undefined
      });
      props.onSaved?.(next);
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const next = await saveVercelSettings({ clear: true });
      props.onSaved?.(next);
      setDraft(emptyDraft());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const verifyBanner = useMemo(() => {
    if (verifying) return { kind: "info" as const, text: "Verifying token…" };
    if (!verifyResult) return null;
    if (verifyResult.ok) {
      const who = verifyResult.email ?? verifyResult.username ?? "Vercel";
      const team = verifyResult.teamSlug ? ` · team ${verifyResult.teamSlug}` : "";
      return { kind: "ok" as const, text: `Signed in as ${who}${team}.` };
    }
    return { kind: "error" as const, text: verifyResult.error ?? "Verification failed." };
  }, [verifyResult, verifying]);

  if (!props.open) return null;

  const canSave =
    !saving &&
    (draft.token.trim().length > 0 ? verifyResult?.ok === true : draft.hasSavedToken);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !saving && props.onClose()}
    >
      <div className="vercel-settings-modal" role="dialog" aria-modal="true" aria-label="Vercel settings">
        <header>
          <h3>Vercel — viewer deployment</h3>
          <button
            type="button"
            className="modal-close"
            onClick={props.onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        {loading ? (
          <div className="publish-modal-loading">Loading…</div>
        ) : (
          <div className="vercel-settings-body">
            <p className="publish-modal-hint">
              The viewer is a static bundle that Simularca pushes to a Vercel project. Connect
              your Vercel account once and the editor can deploy a new viewer version any time
              the publish pre-flight reports an unreleased sha.
            </p>

            {draft.hasSavedToken ? (
              <div className="vercel-settings-current">
                <strong>Connected:</strong> {draft.savedAccountLabel ?? "Vercel account"}
                {draft.savedTeamId ? ` · team ${draft.savedTeamId}` : ""}
                {draft.savedProjectName ? ` · project ${draft.savedProjectName}` : ""}
              </div>
            ) : null}

            <section className="vercel-settings-section">
              <h4>1. Get a token</h4>
              <p className="publish-modal-hint">
                Open your Vercel account's tokens page, click <em>Create Token</em>, set scope to{" "}
                <em>Full Account</em> (or scope it to one team), name it &quot;Simularca&quot;, and copy the token.
              </p>
              <button
                type="button"
                onClick={() => {
                  void openVercelTokensPage();
                }}
              >
                Open vercel.com/account/tokens →
              </button>
            </section>

            <section className="vercel-settings-section">
              <h4>2. Paste the token</h4>
              <label>
                <span>
                  Vercel API token
                  {draft.hasSavedToken ? (
                    <span className="form-hint"> (saved — paste below to replace)</span>
                  ) : null}
                </span>
                <input
                  type="password"
                  value={draft.token}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, token: e.target.value }));
                    setVerifyResult(null);
                  }}
                  placeholder={draft.hasSavedToken ? "••••••••••••••••" : "vercel_xxxxxxxxxxxx"}
                  disabled={saving}
                />
              </label>
              <label>
                <span>
                  Team ID <span className="form-hint">(optional — leave blank for personal account)</span>
                </span>
                <input
                  type="text"
                  value={draft.teamId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, teamId: e.target.value }))}
                  placeholder="team_xxxxxxxxxxxxxx"
                  disabled={saving}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  void handleVerify();
                }}
                disabled={verifying || saving || draft.token.trim().length === 0}
              >
                {verifying ? "Verifying…" : "Verify token"}
              </button>
              {verifyBanner ? (
                <div className={`vercel-settings-banner is-${verifyBanner.kind}`}>
                  {verifyBanner.text}
                </div>
              ) : null}
            </section>

            <section className="vercel-settings-section">
              <h4>3. Project name</h4>
              <p className="publish-modal-hint">
                Pick a Vercel project name. If it doesn't exist yet, Simularca creates it on first deploy.
              </p>
              <label>
                <span>Vercel project name</span>
                <input
                  type="text"
                  value={draft.projectName}
                  onChange={(e) => setDraft((prev) => ({ ...prev, projectName: e.target.value }))}
                  placeholder="simularca-viewer"
                  disabled={saving}
                />
              </label>
            </section>
          </div>
        )}
        {error ? <div className="publish-credentials-error">{error}</div> : null}
        <footer>
          {draft.hasSavedToken ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                void handleDisconnect();
              }}
              disabled={saving}
              title="Forget the Vercel token on this machine."
            >
              Disconnect
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={props.onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void handleSave();
            }}
            disabled={!canSave}
            title={
              draft.token.trim().length > 0 && verifyResult?.ok !== true
                ? "Verify the token first."
                : undefined
            }
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

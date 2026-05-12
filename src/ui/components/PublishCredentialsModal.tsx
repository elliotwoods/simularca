import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadPublishSettings,
  savePublishSettings,
  verifyPublishTarget
} from "@/features/publish/publishClient";
import type {
  PublishTargetWriteRequest,
  RedactedPublishSettings,
  RedactedPublishTarget,
  ValidationField,
  ValidationIssue,
  ValidationSeverity,
  VerifyTargetResult
} from "@/types/ipc";

interface PublishCredentialsModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional: pre-select a specific target id when opened. */
  initialTargetId?: string;
  onSaved?: (settings: RedactedPublishSettings) => void;
}

interface DraftTarget {
  id: string;
  label: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    bucket: string;
    region: string;
  };
  /** Empty string = "no change" (preserve existing). Non-empty replaces. */
  r2SecretInput: string;
  /** True iff the target had a secret on the server. */
  hasExistingR2Secret: boolean;
  bucketBaseUrl: string;
  viewerUrl: string;
  selfHostedEnabled: boolean;
  vercelProjectId: string;
  vercelTeamId: string;
  vercelTokenInput: string;
  hasExistingVercelToken: boolean;
  manifestRetention: string;
}

function newTargetId(): string {
  return `target-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyDraft(): DraftTarget {
  return {
    id: newTargetId(),
    label: "New target",
    r2: { accountId: "", accessKeyId: "", bucket: "", region: "" },
    r2SecretInput: "",
    hasExistingR2Secret: false,
    bucketBaseUrl: "",
    viewerUrl: "https://simularca-viewer.vercel.app",
    selfHostedEnabled: false,
    vercelProjectId: "",
    vercelTeamId: "",
    vercelTokenInput: "",
    hasExistingVercelToken: false,
    manifestRetention: ""
  };
}

function toDraft(target: RedactedPublishTarget): DraftTarget {
  return {
    id: target.id,
    label: target.label,
    r2: {
      accountId: target.r2.accountId,
      accessKeyId: target.r2.accessKeyId,
      bucket: target.r2.bucket,
      region: target.r2.region ?? ""
    },
    r2SecretInput: "",
    hasExistingR2Secret: target.r2.hasSecret,
    bucketBaseUrl: target.bucketBaseUrl,
    viewerUrl: target.viewerUrl,
    selfHostedEnabled: Boolean(target.selfHosted),
    vercelProjectId: target.selfHosted?.vercelProjectId ?? "",
    vercelTeamId: target.selfHosted?.vercelTeamId ?? "",
    vercelTokenInput: "",
    hasExistingVercelToken: Boolean(target.selfHosted?.hasVercelToken),
    manifestRetention: target.manifestRetention?.toString() ?? ""
  };
}

function toWriteRequest(draft: DraftTarget): PublishTargetWriteRequest {
  const secrets: PublishTargetWriteRequest["secrets"] = {};
  if (draft.r2SecretInput.trim().length > 0) {
    secrets.r2SecretAccessKey = draft.r2SecretInput;
  }
  if (draft.selfHostedEnabled && draft.vercelTokenInput.trim().length > 0) {
    secrets.vercelToken = draft.vercelTokenInput;
  }
  const retention = Number.parseInt(draft.manifestRetention, 10);
  return {
    id: draft.id,
    label: draft.label.trim() || "Untitled target",
    r2: {
      accountId: draft.r2.accountId.trim(),
      accessKeyId: draft.r2.accessKeyId.trim(),
      bucket: draft.r2.bucket.trim(),
      region: draft.r2.region.trim() || undefined
    },
    bucketBaseUrl: draft.bucketBaseUrl.trim(),
    viewerUrl: draft.viewerUrl.trim(),
    selfHosted: draft.selfHostedEnabled
      ? {
          vercelProjectId: draft.vercelProjectId.trim() || undefined,
          vercelTeamId: draft.vercelTeamId.trim() || undefined
        }
      : undefined,
    manifestRetention: Number.isFinite(retention) && retention > 0 ? retention : undefined,
    secrets: Object.keys(secrets).length > 0 ? secrets : undefined
  };
}

function isDraftValid(draft: DraftTarget): { valid: boolean; reason?: string } {
  if (!draft.label.trim()) return { valid: false, reason: "Label is required." };
  if (!draft.r2.accountId.trim()) return { valid: false, reason: "Cloudflare account ID is required." };
  if (!draft.r2.accessKeyId.trim()) return { valid: false, reason: "R2 access key ID is required." };
  if (!draft.r2.bucket.trim()) return { valid: false, reason: "R2 bucket name is required." };
  if (!draft.hasExistingR2Secret && !draft.r2SecretInput.trim()) {
    return { valid: false, reason: "R2 secret access key is required for new targets." };
  }
  if (!draft.bucketBaseUrl.trim()) return { valid: false, reason: "Bucket base URL is required." };
  if (!draft.viewerUrl.trim()) return { valid: false, reason: "Viewer URL is required." };
  return { valid: true };
}

export function PublishCredentialsModal(props: PublishCredentialsModalProps) {
  const [drafts, setDrafts] = useState<DraftTarget[]>([]);
  const [defaultTargetId, setDefaultTargetId] = useState<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Map<string, VerifyTargetResult>>(new Map());
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const verifyDebounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!props.open) return;
    setLoading(true);
    setError(null);
    loadPublishSettings()
      .then((settings) => {
        const next = settings.targets.map(toDraft);
        setDrafts(next);
        // A single target must always be the default — no UI affordance to
        // un-default the only target you have.
        const nextDefault =
          next.length === 1 ? next[0]!.id : settings.defaultTargetId;
        setDefaultTargetId(nextDefault);
        const initial =
          props.initialTargetId && next.some((d) => d.id === props.initialTargetId)
            ? props.initialTargetId
            : next[0]?.id ?? null;
        setActiveId(initial);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, [props.initialTargetId, props.open]);

  // Whenever the draft list collapses to exactly one target, force-default it.
  // Whenever it collapses to zero, clear the stale default reference.
  useEffect(() => {
    if (drafts.length === 0) {
      setDefaultTargetId(undefined);
      return;
    }
    if (drafts.length === 1) {
      setDefaultTargetId(drafts[0]!.id);
      return;
    }
    if (defaultTargetId && !drafts.some((d) => d.id === defaultTargetId)) {
      setDefaultTargetId(drafts[0]!.id);
    }
  }, [defaultTargetId, drafts]);

  const activeDraft = useMemo(
    () => drafts.find((d) => d.id === activeId) ?? null,
    [activeId, drafts]
  );

  const runSyncVerify = useCallback(async (draft: DraftTarget): Promise<void> => {
    try {
      const result = await verifyPublishTarget({
        draft: toWriteRequest(draft),
        skipNetwork: true
      });
      setVerifyResults((prev) => {
        const next = new Map(prev);
        next.set(draft.id, result);
        return next;
      });
    } catch (reason) {
      // Silently ignore — sync verify is best-effort; the Save path runs a
      // full verify and surfaces IPC errors there.
      void reason;
    }
  }, []);

  const scheduleSyncVerify = useCallback(
    (draft: DraftTarget): void => {
      const timers = verifyDebounceTimers.current;
      const existing = timers.get(draft.id);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        timers.delete(draft.id);
        void runSyncVerify(draft);
      }, 200);
      timers.set(draft.id, handle);
    },
    [runSyncVerify]
  );

  const updateActive = (patch: Partial<DraftTarget>): void => {
    setDrafts((prev) => {
      const next = prev.map((draft) =>
        draft.id === activeId ? { ...draft, ...patch } : draft
      );
      const updated = next.find((d) => d.id === activeId);
      if (updated) scheduleSyncVerify(updated);
      return next;
    });
  };

  const updateActiveR2 = (patch: Partial<DraftTarget["r2"]>): void => {
    setDrafts((prev) => {
      const next = prev.map((draft) =>
        draft.id === activeId ? { ...draft, r2: { ...draft.r2, ...patch } } : draft
      );
      const updated = next.find((d) => d.id === activeId);
      if (updated) scheduleSyncVerify(updated);
      return next;
    });
  };

  // Initial sync verify per draft on load.
  useEffect(() => {
    if (loading) return;
    for (const draft of drafts) {
      if (!verifyResults.has(draft.id)) {
        void runSyncVerify(draft);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, drafts.length]);

  // Cleanup pending debounce timers on close.
  useEffect(() => {
    if (props.open) return;
    const timers = verifyDebounceTimers.current;
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
  }, [props.open]);

  const handleManualVerify = useCallback(async (): Promise<void> => {
    if (!activeDraft) return;
    setVerifyingId(activeDraft.id);
    setError(null);
    try {
      const result = await verifyPublishTarget({
        draft: toWriteRequest(activeDraft),
        skipNetwork: false
      });
      setVerifyResults((prev) => {
        const next = new Map(prev);
        next.set(activeDraft.id, result);
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVerifyingId(null);
    }
  }, [activeDraft]);

  const handleAddTarget = (): void => {
    const fresh = emptyDraft();
    setDrafts((prev) => [...prev, fresh]);
    setActiveId(fresh.id);
  };

  const handleRemoveActive = (): void => {
    if (!activeId) return;
    setDrafts((prev) => prev.filter((draft) => draft.id !== activeId));
    setActiveId((prev) => {
      const remaining = drafts.filter((draft) => draft.id !== prev);
      return remaining[0]?.id ?? null;
    });
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    for (const draft of drafts) {
      const validity = isDraftValid(draft);
      if (!validity.valid) {
        setActiveId(draft.id);
        setError(`${draft.label}: ${validity.reason ?? "invalid"}`);
        return;
      }
    }
    // Full live verification (network probes included) on every draft. Block
    // save if any draft has errors; surface the first failing one in the UI.
    setSaving(true);
    try {
      const verifyResultsByDraft = new Map<string, VerifyTargetResult>();
      for (const draft of drafts) {
        setVerifyingId(draft.id);
        const result = await verifyPublishTarget({
          draft: toWriteRequest(draft),
          skipNetwork: false
        });
        verifyResultsByDraft.set(draft.id, result);
      }
      setVerifyingId(null);
      setVerifyResults((prev) => {
        const next = new Map(prev);
        for (const [id, result] of verifyResultsByDraft) next.set(id, result);
        return next;
      });
      const firstFailing = drafts.find((draft) => verifyResultsByDraft.get(draft.id)?.ok === false);
      if (firstFailing) {
        setActiveId(firstFailing.id);
        setError(
          `"${firstFailing.label}" has validation errors — please fix them before saving (or use Skip-verify if you're sure).`
        );
        return;
      }
      const settings = await savePublishSettings({
        targets: drafts.map(toWriteRequest),
        defaultTargetId
      });
      props.onSaved?.(settings);
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
      setVerifyingId(null);
    }
  };

  const handleSaveAnyway = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const settings = await savePublishSettings({
        targets: drafts.map(toWriteRequest),
        defaultTargetId
      });
      props.onSaved?.(settings);
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const activeVerifyResult = activeDraft ? verifyResults.get(activeDraft.id) ?? null : null;
  const issuesByField = useMemo(() => {
    const map = new Map<ValidationField, ValidationIssue[]>();
    if (!activeVerifyResult) return map;
    for (const issue of activeVerifyResult.issues) {
      const bucket = map.get(issue.field) ?? [];
      bucket.push(issue);
      map.set(issue.field, bucket);
    }
    return map;
  }, [activeVerifyResult]);

  function severityFor(field: ValidationField): ValidationSeverity | null {
    const list = issuesByField.get(field);
    if (!list || list.length === 0) return null;
    if (list.some((i) => i.severity === "error")) return "error";
    if (list.some((i) => i.severity === "warning")) return "warning";
    return "info";
  }
  // Surface the worst severity in the sidebar dot per target.
  const sidebarSeverityById = useMemo(() => {
    const map = new Map<string, ValidationSeverity>();
    for (const [id, result] of verifyResults) {
      let worst: ValidationSeverity = "info";
      for (const issue of result.issues) {
        if (issue.severity === "error") {
          worst = "error";
          break;
        }
        if (issue.severity === "warning") worst = "warning";
      }
      if (result.issues.length > 0) map.set(id, worst);
    }
    return map;
  }, [verifyResults]);

  if (!props.open) return null;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="publish-credentials-modal" role="dialog" aria-modal="true" aria-label="Publish targets">
        <header>
          <h3>Publish targets</h3>
          <button type="button" className="modal-close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>
        {loading ? (
          <div className="publish-credentials-loading">Loading…</div>
        ) : (
          <div className="publish-credentials-body">
            <aside className="publish-credentials-sidebar">
              <div className="publish-credentials-target-list">
                {drafts.length === 0 ? (
                  <p className="publish-credentials-empty">No publish targets yet.</p>
                ) : (
                  drafts.map((draft) => {
                    const severity = sidebarSeverityById.get(draft.id);
                    const dotClass = severity ? `is-${severity}` : "";
                    return (
                      <button
                        key={draft.id}
                        type="button"
                        className={`publish-credentials-target-item${draft.id === activeId ? " is-active" : ""}`}
                        onClick={() => setActiveId(draft.id)}
                      >
                        <span className="publish-credentials-target-label">
                          {severity ? <span className={`publish-credentials-target-dot ${dotClass}`} aria-hidden="true" /> : null}
                          {draft.label || "Untitled"}
                        </span>
                        <span className="publish-credentials-target-bucket">{draft.r2.bucket || "—"}</span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="publish-credentials-sidebar-actions">
                <button type="button" onClick={handleAddTarget}>
                  + Add target
                </button>
                {activeDraft ? (
                  <button type="button" onClick={handleRemoveActive} className="danger">
                    Remove
                  </button>
                ) : null}
              </div>
            </aside>
            <div className="publish-credentials-detail">
              {activeDraft ? (
                <DetailForm
                  draft={activeDraft}
                  isDefault={defaultTargetId === activeDraft.id}
                  isOnlyTarget={drafts.length === 1}
                  issuesByField={issuesByField}
                  severityFor={severityFor}
                  onChange={updateActive}
                  onChangeR2={updateActiveR2}
                  onSetDefault={() => setDefaultTargetId(activeDraft.id)}
                  onClearDefault={() => setDefaultTargetId(undefined)}
                />
              ) : (
                <div className="publish-credentials-detail-empty">
                  Select a target to edit, or add a new one.
                </div>
              )}
              <details className="publish-credentials-onboarding">
                <summary>How to set up a Cloudflare R2 target</summary>
                <ol>
                  <li>
                    <strong>Sign in to Cloudflare</strong> at <code>dash.cloudflare.com</code>. On the dashboard home page,
                    your <strong>Account ID</strong> (32-char hex) is shown on the right sidebar — copy it into the
                    "Account ID" field above. This is NOT your bucket name or username.
                  </li>
                  <li>
                    <strong>Create an R2 bucket.</strong> Sidebar → <em>R2 Object Storage</em> → <em>Create bucket</em>.
                    Pick a name (you'll use it as <em>Bucket</em> above). Free tier covers 10 GB / 1 M Class A ops per month.
                  </li>
                  <li>
                    <strong>Enable public access.</strong> Open the bucket → <em>Settings</em> →
                    <em>Public access</em> → enable the <code>r2.dev</code> subdomain (gives you a
                    <code>pub-&lt;hash&gt;.r2.dev</code> URL) <em>or</em> attach a custom domain. This URL is
                    your <em>Bucket base URL</em>.
                  </li>
                  <li>
                    <strong>Configure CORS.</strong> Bucket → <em>Settings</em> → <em>CORS Policy</em>.
                    Add a rule allowing your viewer origin (e.g. <code>https://simularca-viewer.vercel.app</code>)
                    with methods <code>GET</code> and <code>HEAD</code>. Without CORS the viewer can fetch
                    nothing — fail mode is opaque "Failed to fetch" errors.
                  </li>
                  <li>
                    <strong>Create an R2 API token.</strong> R2 sidebar → <em>Manage R2 API Tokens</em> →
                    <em>Create API token</em>. Set permission to <strong>Object Read &amp; Write</strong>.
                    Under <em>Specify bucket(s)</em>, scope it to just the bucket from step 2 (principle of least
                    privilege; do NOT grant access to all buckets). Submit. Cloudflare shows the
                    <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> exactly once — paste both
                    into the fields above.
                  </li>
                  <li>
                    Leave <em>Region</em> blank (Cloudflare uses <code>auto</code>). Save the target.
                  </li>
                </ol>
                <p className="publish-credentials-onboarding-note">
                  <strong>What these credentials are used for:</strong> Simularca uses your R2 API token
                  <em> on this machine only</em> to upload snapshots, assets, and manifests to your bucket
                  when you click <em>Publish</em>. The token is stored locally (the Secret Access Key in
                  <code> publish-settings.json</code> under your Simularca user data folder; the Vercel
                  token, if set, is additionally encrypted via your OS keychain).
                </p>
                <p className="publish-credentials-onboarding-note">
                  <strong>What is NOT done with them:</strong> The API token is never sent to Simularca,
                  Vercel, or any third party — only to Cloudflare's R2 endpoint for your bucket. The
                  published viewer that opens in someone's browser uses only the bucket's <em>public</em>
                  URL (<code>bucketBaseUrl</code>) to read the files; it never sees the API token.
                </p>
              </details>
            </div>
          </div>
        )}
        {error ? <div className="publish-credentials-error">{error}</div> : null}
        <footer>
          <button
            type="button"
            onClick={() => {
              void handleManualVerify();
            }}
            disabled={loading || saving || !activeDraft || Boolean(verifyingId)}
            title="Re-run validation against R2 right now"
          >
            {verifyingId ? "Verifying…" : "Verify now"}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={props.onClose} disabled={saving}>
            Cancel
          </button>
          {activeVerifyResult && !activeVerifyResult.ok ? (
            <button
              type="button"
              onClick={() => {
                void handleSaveAnyway();
              }}
              disabled={loading || saving}
              title="Save the entered values even though validation flagged errors. Useful if you're sure the validator is wrong."
            >
              {saving ? "Saving…" : "Save anyway"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={loading || saving}
            className="primary"
          >
            {saving ? "Verifying & saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface DetailFormProps {
  draft: DraftTarget;
  isDefault: boolean;
  isOnlyTarget: boolean;
  issuesByField: Map<ValidationField, ValidationIssue[]>;
  severityFor: (field: ValidationField) => ValidationSeverity | null;
  onChange: (patch: Partial<DraftTarget>) => void;
  onChangeR2: (patch: Partial<DraftTarget["r2"]>) => void;
  onSetDefault: () => void;
  onClearDefault: () => void;
}

interface FieldLabelProps {
  label: string;
  help: string;
}

function FieldLabel({ label, help }: FieldLabelProps) {
  return (
    <span className="publish-field-label">
      {label}
      <span className="publish-field-help" title={help} aria-label={help} role="img">
        ?
      </span>
    </span>
  );
}

interface FieldIssuesProps {
  issues: ValidationIssue[] | undefined;
}

function FieldIssues({ issues }: FieldIssuesProps) {
  if (!issues || issues.length === 0) return null;
  return (
    <span className="publish-field-issues">
      {issues.map((issue, index) => (
        <span key={index} className={`publish-field-issue is-${issue.severity}`}>
          {issue.message}
        </span>
      ))}
    </span>
  );
}

function inputClassForField(field: ValidationField, severityFor: (f: ValidationField) => ValidationSeverity | null): string {
  const severity = severityFor(field);
  if (severity === "error") return "is-invalid";
  if (severity === "warning") return "is-warning";
  return "";
}

function DetailForm(props: DetailFormProps) {
  const { draft, isDefault, isOnlyTarget, issuesByField, severityFor } = props;
  const cls = (field: ValidationField): string => inputClassForField(field, severityFor);
  return (
    <div className="publish-credentials-detail-form">
      <div className="form-row">
        <label>
          <FieldLabel label="Label" help="A human name for this target — shown in the publish dropdown. Pick whatever you like (e.g. 'Production', 'Staging')." />
          <input
            type="text"
            className={cls("label")}
            value={draft.label}
            onChange={(e) => props.onChange({ label: e.target.value })}
            placeholder="Production / Staging / …"
          />
          <FieldIssues issues={issuesByField.get("label")} />
        </label>
        <label className="default-toggle" title={isOnlyTarget ? "Only target — automatically set as default." : "Use this target by default when publishing."}>
          <input
            type="checkbox"
            checked={isDefault || isOnlyTarget}
            disabled={isOnlyTarget}
            onChange={(e) => (e.target.checked ? props.onSetDefault() : props.onClearDefault())}
          />
          <span>Default target</span>
        </label>
      </div>
      <fieldset>
        <legend>Cloudflare R2</legend>
        <div className="form-row">
          <label>
            <FieldLabel
              label="Account ID"
              help="Your Cloudflare account ID — a 32-char hex string shown on the right of the Cloudflare dashboard's main page (under 'Account ID'). NOT the bucket name. The R2 endpoint will be: https://<this-value>.r2.cloudflarestorage.com"
            />
            <input
              type="text"
              className={cls("accountId")}
              value={draft.r2.accountId}
              onChange={(e) => props.onChangeR2({ accountId: e.target.value })}
              placeholder="1234567890abcdef1234567890abcdef"
            />
            <FieldIssues issues={issuesByField.get("accountId")} />
          </label>
          <label>
            <FieldLabel
              label="Bucket"
              help="The R2 bucket name you created (e.g. 'simularca-projects'). Cloudflare dashboard → R2 → your bucket → bucket name shown at top."
            />
            <input
              type="text"
              className={cls("bucket")}
              value={draft.r2.bucket}
              onChange={(e) => props.onChangeR2({ bucket: e.target.value })}
            />
            <FieldIssues issues={issuesByField.get("bucket")} />
          </label>
        </div>
        <div className="form-row">
          <label>
            <FieldLabel
              label="Access key ID"
              help="The Access Key ID half of an R2 API token. Create one at: Cloudflare dashboard → R2 → 'Manage R2 API Tokens' → 'Create API token'. Use 'Object Read & Write' scope, restrict to this bucket. The token name is your label here."
            />
            <input
              type="text"
              className={cls("accessKeyId")}
              value={draft.r2.accessKeyId}
              onChange={(e) => props.onChangeR2({ accessKeyId: e.target.value })}
            />
            <FieldIssues issues={issuesByField.get("accessKeyId")} />
          </label>
          <label>
            <FieldLabel
              label="Region (optional)"
              help="R2 region. Leave blank for 'auto' — Cloudflare picks the closest region. Only set this if you've explicitly bound the bucket to a region (rare)."
            />
            <input
              type="text"
              className={cls("region")}
              value={draft.r2.region}
              onChange={(e) => props.onChangeR2({ region: e.target.value })}
              placeholder="auto"
            />
            <FieldIssues issues={issuesByField.get("region")} />
          </label>
        </div>
        <label>
          <FieldLabel
            label="Secret access key"
            help="The Secret Access Key half of your R2 API token — shown once when you create the token in the Cloudflare dashboard. Stored locally on this machine in publish-settings.json. The token is sent only to Cloudflare's R2 endpoint for uploads; the published viewer in a visitor's browser uses only your bucket's public URL and never sees the token."
          />
          {draft.hasExistingR2Secret ? (
            <span className="form-hint">Saved — type below to replace.</span>
          ) : null}
          <input
            type="password"
            className={cls("secretAccessKey")}
            value={draft.r2SecretInput}
            onChange={(e) => props.onChange({ r2SecretInput: e.target.value })}
            placeholder={draft.hasExistingR2Secret ? "••••••••••••••••" : ""}
          />
          <FieldIssues issues={issuesByField.get("secretAccessKey")} />
        </label>
        <label>
          <FieldLabel
            label="Bucket base URL (public)"
            help="The publicly-reachable URL for objects in your bucket. Either Cloudflare's R2.dev URL (https://pub-<hash>.r2.dev) — enable 'R2.dev subdomain' under your bucket's Settings → Public access — or a custom domain you've bound to the bucket. No trailing slash."
          />
          <input
            type="url"
            className={cls("bucketBaseUrl")}
            value={draft.bucketBaseUrl}
            onChange={(e) => props.onChange({ bucketBaseUrl: e.target.value })}
            placeholder="https://pub-<hash>.r2.dev"
          />
          <FieldIssues issues={issuesByField.get("bucketBaseUrl")} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Viewer</legend>
        <label>
          <FieldLabel
            label="Viewer URL"
            help="Where the published-snapshot web viewer is hosted. The publish flow checks that this URL serves /v/<editor-sha>/viewer.html. Default is the central Simularca viewer; advanced users can self-host."
          />
          <input
            type="url"
            className={cls("viewerUrl")}
            value={draft.viewerUrl}
            onChange={(e) => props.onChange({ viewerUrl: e.target.value })}
            placeholder="https://simularca-viewer.vercel.app"
          />
          <FieldIssues issues={issuesByField.get("viewerUrl")} />
        </label>
        <label className="default-toggle">
          <input
            type="checkbox"
            checked={draft.selfHostedEnabled}
            onChange={(e) => props.onChange({ selfHostedEnabled: e.target.checked })}
          />
          <span>Self-hosted viewer (advanced)</span>
        </label>
        {draft.selfHostedEnabled ? (
          <div className="publish-credentials-self-hosted">
            <p className="form-hint">
              You manage the viewer deployment. Publishing will block until the configured viewer URL serves
              <code> /v/&lt;sha&gt;/viewer.html</code>.
            </p>
            <div className="form-row">
              <label>
                <FieldLabel
                  label="Vercel project ID"
                  help="The ID of the Vercel project that hosts your self-hosted viewer. Vercel dashboard → project → Settings → General → 'Project ID'."
                />
                <input
                  type="text"
                  value={draft.vercelProjectId}
                  onChange={(e) => props.onChange({ vercelProjectId: e.target.value })}
                />
              </label>
              <label>
                <FieldLabel
                  label="Vercel team ID (optional)"
                  help="If the project lives under a Vercel team (not your personal account), include the team ID. Vercel dashboard → team → Settings → 'Team ID'."
                />
                <input
                  type="text"
                  value={draft.vercelTeamId}
                  onChange={(e) => props.onChange({ vercelTeamId: e.target.value })}
                />
              </label>
            </div>
            <label>
              <FieldLabel
                label="Vercel API token"
                help="A Vercel API token scoped to this project (Vercel → Settings → Tokens → Create). Encrypted at rest via the OS keychain. Required for the in-app 'Deploy viewer' action."
              />
              {draft.hasExistingVercelToken ? (
                <span className="form-hint">Saved — type below to replace.</span>
              ) : null}
              <input
                type="password"
                value={draft.vercelTokenInput}
                onChange={(e) => props.onChange({ vercelTokenInput: e.target.value })}
                placeholder={draft.hasExistingVercelToken ? "••••••••••••••••" : ""}
              />
            </label>
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>Retention (advanced)</legend>
        <label>
          <FieldLabel
            label="Manifest retention (count)"
            help="How many historical manifests to keep per publish ID. Older manifests (and their referenced snapshots / publishConfig) are garbage-collected. Default is 10. Higher = more rollback history; lower = less R2 storage cost."
          />
          <input
            type="number"
            min={1}
            max={500}
            value={draft.manifestRetention}
            onChange={(e) => props.onChange({ manifestRetention: e.target.value })}
            placeholder="10 (default)"
          />
        </label>
      </fieldset>
    </div>
  );
}

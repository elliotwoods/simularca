# Self-hosting the Simularca viewer

The viewer is the read-only web build of Simularca that loads a published
snapshot from a user's Cloudflare R2 bucket. Most users let the central
deployment at `simularca-viewer.vercel.app` handle this. Power users can
self-host instead — for branding, network policy, or to put the viewer behind
their own auth.

This doc covers what a self-hosted viewer deployment needs to provide so
publishes from the Simularca editor work against it.

---

## Invariants the editor depends on

The publish flow embeds **the editor's commit short sha** into every publish
manifest as `requiredViewerSha`. The published URL is:

```
<viewerUrl>/v/<requiredViewerSha>/p/<publishId>?b=<bucketBaseUrl>
```

For the published URL to load, the viewer host must satisfy:

| Invariant | What it means |
| --- | --- |
| **Versioned paths are immutable** | Once `/v/abc1234/viewer.html` is live, never change it. Old publishes embed that sha and will 404 if you delete or modify the path. |
| **Path rewrite** `/v/:sha/p/:id` → `/v/:sha/viewer.html?p=:id` | The viewer reads `publishId` from `?p=`. Without the rewrite the URL 404s. |
| **`?b=` is preserved** | The viewer reads the publishing user's `bucketBaseUrl` from `?b=`. The rewrite must keep query params intact (Vercel does this by default). |
| **CSP allows `script-src 'self' blob:`** | The viewer dynamic-imports non-core plugin bundles via `URL.createObjectURL`. Blocking `blob:` breaks plugin loading. |
| **Immutable cache** on `/v/*` | `Cache-Control: public, max-age=31536000, immutable`. Same-sha viewers should never re-fetch. |

The provided `vercel.json` at the repo root satisfies all of this.

---

## Build

```sh
npm ci
node scripts/write-build-info.mjs build   # writes .simularca-build-info.json
node scripts/build-viewer.mjs             # emits dist/v/<sha>/
```

`scripts/build-viewer.mjs` only builds the viewer entry — the editor entry
(Electron-only) is intentionally excluded so editor-only code never ships to
the public viewer. The script also runs a leak assertion that fails the build
if any of the dev-only escape strings (`manifest=`, `dev-publish`) appear in
the output.

The output structure:

```
dist/v/<sha>/
  viewer.html
  assets/viewer-<hash>.js
  assets/kernel-<hash>.js
  assets/kernel-<hash>.css
  …
```

Deploy `dist/` to your host of choice.

---

## Minimum platform requirements

### CSP

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' https:;
  worker-src 'self' blob:;
  font-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'none';
```

- `script-src 'self' blob:` is **required** — the plugin loader fetches
  plugin bundles from R2, wraps them in a `Blob`, and dynamic-imports them.
- `connect-src 'self' https:` lets the viewer fetch the manifest /
  snapshot / asset payload from any user's R2 bucket. If you want to lock
  this down to specific buckets, swap `https:` for an explicit allow-list
  — but the user's `bucketBaseUrl` varies per publish, so the dynamic
  case won't work.
- `frame-ancestors 'none'` prevents the viewer being iframed by attackers.
  Loosen if you intentionally embed the viewer.

### URL rewrite

```
/v/:sha/p/:id  →  /v/:sha/viewer.html?p=:id
```

Vercel: see the included `vercel.json`. Other platforms have equivalents:

- **Cloudflare Pages**: `_redirects` file. Note: `_redirects` does not
  support capturing path segments into the destination's query string.
  Use a Pages Function instead, or fall back to serving `viewer.html`
  directly at `/v/<sha>/viewer.html?p=<id>&b=<bucket>` URLs.
- **Netlify**: `_redirects` with `:splat` captures — same caveat.
- **Static (Nginx / Caddy / Apache)**: easy, native rewrite support.
- **GitHub Pages**: no URL rewrites available. Self-hosting on GitHub
  Pages requires publishing URLs in their query-string form
  (`/v/<sha>/viewer.html?p=<id>&b=<bucket>`) — change the publish-flow
  to emit those instead. (Currently the editor only emits the path form.)

---

## CORS on the publishing user's R2 bucket

The viewer fetches `latest.json`, `manifest-<sha>.json`,
`snapshots/<name>-<sha>.json`, `publishConfig-<sha>.json`, and
`assets/sha256/<hex>` from the bucket the publisher configured. Each user's
R2 bucket must therefore allow your viewer origin:

```jsonc
[
  {
    "AllowedOrigins": ["https://your-viewer.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

If you operate multiple viewer hosts (e.g. staging + production), list them
all. Publishing users configure CORS once via the Cloudflare dashboard
(Bucket → Settings → CORS Policy).

---

## Optional: in-app "Deploy viewer to my Vercel"

The Simularca editor has a hidden self-hosted path that uploads a viewer
bundle to a user-owned Vercel project. This requires:

- A Vercel API token, scoped to one project, supplied via the credentials
  modal under **Self-hosted viewer (advanced)**.
- The token is encrypted at rest on the user's machine via Electron's
  `safeStorage.encryptString` (OS keychain).
- `electron/vercelDeploy.ts` currently exports a `deployViewerVersion()`
  placeholder that throws. Wiring the real `@vercel/client` SDK call is a
  follow-up task.

Until that ships, self-hosters deploy via this repo's GitHub Actions
workflow or their own CI.

---

## Versioning policy

- `requiredViewerSha` is `commitShortSha` from `.simularca-build-info.json`
  (8 hex chars). Generated in `scripts/write-build-info.mjs`.
- Editor and viewer always release together. Bumping the editor without
  redeploying the viewer breaks all *new* publishes (old URLs are fine
  because they reference an older sha).
- Garbage-collecting old `/v/<sha>/` paths breaks every publish that
  referenced them. Don't do it unless you accept the breakage.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Viewer URL returns 404 | The sha isn't deployed yet. Check `HEAD /v/<sha>/viewer.html`. |
| Viewer loads, then "Failed to fetch publish pointer" | R2 CORS not configured for the viewer origin. |
| Viewer loads, shows "Asset not found in publish manifest" | Mismatched `projectUuid` — the identity-bridging contract in `webStorageAdapter.ts` was violated. Should not happen unless something is hand-rolling the manifest. |
| Plugin fails to load: "external X major version mismatch" | The plugin was bundled against a different major of `three`/`react`/etc. than the viewer ships. Re-bundle the plugin against the current `viewer-externals.json`. |
| Plugin fails with CSP violation | Your CSP is missing `script-src 'self' blob:`. |

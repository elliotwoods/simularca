# dev-publish/

Drop hand-crafted publish payloads here for local viewer smoke-testing.

## Usage

1. Serve a payload at `public/dev-publish/<your-name>.json` shaped like:
   ```jsonc
   {
     "bucketBaseUrl": "/dev-publish",
     "publishConfig": { /* optional — defaults applied if omitted */ },
     "manifest": { /* PublishManifest matching publishManifestSchema.ts */ }
   }
   ```
2. Place referenced snapshot JSON at `public/dev-publish/snapshots/<name>-<sha>.json`.
3. Place referenced assets at the bucket-relative paths from `manifest.assets`
   (e.g. `public/dev-publish/assets/sha256/<hex>`).
4. Run `npm run dev:web` and open
   `http://localhost:5180/viewer.html?manifest=/dev-publish/<your-name>.json`.

## Easiest path: copy a real Electron-saved snapshot

```
# 1. Find an existing project's snapshot (wherever you save projects)
#    e.g. C:\Users\<you>\Documents\Simularca Projects\MyProject.simularca\snapshots\main.json

# 2. Copy it under a content-addressed name
mkdir -p public/dev-publish/snapshots
cp <real-snapshot.json> public/dev-publish/snapshots/main-test.json

# 3. Mirror the asset folder — the manifest's assets[] needs each
#    `<projectUuid>/<relativePath>` to point at a bucket-relative URL
mkdir -p public/dev-publish/assets/raw
cp -r <real-project>/assets/* public/dev-publish/assets/raw/

# 4. Hand-write public/dev-publish/example.json — see schema reference below
```

## Schema reference

- `PublishManifest` shape: `src/features/publish/publishManifestSchema.ts`
- `PublishConfig` shape: `src/features/publish/publishConfigSchema.ts`

## Notes

- This dev escape is **build-time gated** in `src/viewer/main.tsx` via
  `import.meta.env.DEV`. The leak assertion in `scripts/build-viewer.mjs`
  refuses to ship if any production bundle contains the strings
  `manifest=` or `dev-publish`.
- The bundled viewer build itself is tested by running `node scripts/build-viewer.mjs`.

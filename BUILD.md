# Build Instructions

## Frontend

The frontend is a vanilla JS single-page app. The base bundle (`main-*.js`) is produced by esbuild upstream (not included in this repo). Additional feature modules (the WYSIWYG site builder, resume builder, and films section) are developed as standalone source files and patched into the base bundle by `bv-build.mjs`.

### Prerequisites

- Node.js 20+
- The upstream base bundle file (`dist/main-023E1787.js` or equivalent) placed at the expected path

### Source Files

```
frontend/
├── bv-build.mjs           # Build script: reads sources, writes dist/
├── bv-builder.src.js      # #/studio WYSIWYG site builder chunk
├── bv-resume.src.js       # #/resume resume builder chunk
├── bv-films.src.js        # #/library Films & TV section chunk
├── bv-site-route.js       # #/site editor route registration
├── bv-sitecode-route.js   # #/sitecode route registration
├── bv-studio-route.js     # #/studio route registration
├── bv-explore-route.js    # #/explore directory route registration
├── bv-resume-route.js     # #/resume route registration
├── bv-films-mount.js      # Films section mount hook (wraps #/library)
└── bv-site-nav.txt        # Nav entries injected into the bundle
```

### Running the Build

```bash
node bv-build.mjs
```

The script prints:

```
BUILDER_CHUNK=bv-builder-XXXXXXXX.js
RESUME_CHUNK=bv-resume-XXXXXXXX.js
FILMS_CHUNK=bv-films-XXXXXXXX.js
NEW_MAIN=main-XXXXXXXX.js
TO DEPLOY: point index.html at main-XXXXXXXX.js and bump the SW version.
```

### What the Build Script Does

1. **Chunk hashing**: each source module (`bv-builder.src.js`, `bv-resume.src.js`, `bv-films.src.js`) is written to `dist/chunks/` with a content-hash filename (`bv-builder-<sha256[0:8]>.js`). The hash changes only when the source changes, so the browser's cache is never stale.

2. **Route injection**: route and nav snippets are concatenated. The placeholder tokens `__BUILDER_HASH__`, `__RESUME_HASH__`, and `__FILMS_HASH__` are substituted with the real content-hashed filenames. Guards throw if any token is left unresolved.

3. **Base patching**: several idempotent patches are applied to the pristine esbuild entry:
   - Nav entries and route registrations are inserted at known anchor strings.
   - Auto-login after account creation (sets the in-memory session immediately after register, routes to dashboard instead of login).
   - Films section: wraps the library route handler to call the injected `bvFilmsMount` global.
   - Service worker registered as classic (not module) to support `importScripts` in the shim.
   - Quick-tile label rebrand for the Digital Library tile.

4. **Output**: a new content-hashed `main-XXXXXXXX.js` is written to `dist/`. The script does **not** modify `index.html` or deploy anything.

### Deployment After Build

After running the build:

1. Update `index.html` to reference the new `main-*.js` filename.
2. Bump the service worker version string so clients re-fetch the updated bundle.
3. Reload nginx (or wait for the max-age=600 cache to expire).

```bash
# Example: update the script tag in index.html
sed -i 's|dist/main-[A-F0-9]*.js|dist/'"$NEW_MAIN"'|g' /var/www/blindvault/index.html
```

### Guards

The build script has inline guards that throw on missing or non-unique anchors. If you see an error like `GUARD: anchor missing: nav`, the base bundle has diverged from the expected version. Either update the anchor constants in `bv-build.mjs` or regenerate the base bundle.

### Session Chunk Note

The esbuild session chunk (`chunk-7Y2BX7P2.js`) must **not** be renamed or re-imported under a new URL. ES modules are singletons per URL; importing the same logical module under two different URLs creates two separate in-memory instances, which causes the auth state seen by the UI to diverge from the state set at login (the user appears permanently logged out). The build script checks that the base bundle references the expected chunk name.

---

## Backend Services

The backend services are plain Node.js (no compilation step) and Python scripts. Install dependencies with:

```bash
# bv-sites
cd services/bv-sites && npm ci --omit=dev

# bv-resume
cd services/bv-resume && npm ci --omit=dev

# bv-shots
cd services/bv-shots && npm ci --omit=dev
npx playwright install chromium   # downloads the browser binary

# bv-board, bv-blobstore — zero npm dependencies, no install needed

# Python services
python3 -m venv /opt/blindvault/ytdlp-venv
/opt/blindvault/ytdlp-venv/bin/pip install yt-dlp
```

---

## Core API (Rust)

The core API (`blindvault-api`) is a Rust binary. Pre-built releases are provided for x86-64 Linux. To build from source, you need the Rust source repository (separate from this one):

```bash
cargo build --release
# Binary produced at: target/release/blindvault-api
```

The binary is statically linked (no runtime library dependencies) and can be deployed by copying it to `/opt/blindvault/bin/`.

---

## Development Tips

- Run `node bv-build.mjs 2>&1` and check for GUARD errors before copying output to the web root.
- The build is fully idempotent: running it multiple times with the same source produces the same output filenames (content-hashed).
- To test a chunk change in isolation without a full redeploy, copy the new `dist/chunks/bv-builder-*.js` to the web root and update only the `<script>` reference in the relevant route file, then rebuild.
- The `dist/chunks/` directory accumulates old hashed files over time. It is safe to delete any file whose name does not appear in the current `index.html`'s bundle.

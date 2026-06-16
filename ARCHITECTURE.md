# Blindvault Architecture

Blindvault is a privacy-first PWA (Progressive Web App) with a single-page frontend and a fleet of small, single-purpose backend services. All services listen on loopback only; nginx is the sole public-facing process.

## System Diagram

```
Browser / Mobile PWA
        │
        │  HTTPS (TLS 1.2/1.3)
        ▼
┌───────────────────────────────────────────────────────────────┐
│                          nginx                                │
│                   (edge, hardened)                            │
│                                                               │
│  /                  → static files (/var/www/blindvault)      │
│  /dist/*            → content-hashed JS/CSS chunks            │
│  /vendor/*,/fonts/* → immutable vendor assets                 │
│  /site-thumbs/      → /var/lib/bv-shots/thumbs/<handle>.jpg  │
│  /r/<slug>          → /var/lib/bv-resume/shared/<slug>.html   │
│  /api/*             → loopback proxy (per service below)      │
│  <handle>.domain    → /var/lib/bv-sites/<handle>/published/   │
└─────────┬─────────────────────────────────────────────────────┘
          │ loopback only
          ├──────────────────────────────────────────────────────┐
          │                                                      │
          ▼ :8088                                                │
┌─────────────────────┐                                         │
│   blindvault-api    │  Rust/Axum binary                       │
│   (core auth/vault) │  PostgreSQL 16 (TLS loopback)           │
│                     │  ← /api/* (catch-all)                   │
└─────────┬───────────┘                                         │
          │ Bearer token delegation                             │
          │ (services call /api/users/me to validate tokens)    │
          ▼                                                      │
┌──────────────────────────────────────────────────────────────┐│
│                   Node.js micro-services                      ││
│                                                              ││
│  bv-blobstore  :8799  ← /api/ (vault files, inbox bodies)   ││
│  bv-sites      :8800  ← /api/sites/*                        ││
│  bv-board      :8802  ← /api/board/*                        ││
│  bv-shots      :8803  ← (internal only, fired by bv-sites)  ││
│  bv-resume     :8805  ← /api/resume/*                       ││
└──────────────────────────────────────────────────────────────┘│
                                                                │
┌──────────────────────────────────────────────────────────────┘
│   Python services
│
│  bv-route-proxy   :8084  ← /api/route, /api/geocode
│    └── Valhalla   :8002  (local routing engine)
│    └── Nominatim  :8085  (local geocoder)
│
│  bv-download-proxy :8082 ← /api/download/*
│    └── yt-dlp (subprocess, venv)
│
│  bv-book-proxy    :8083  ← /api/books/*
│    └── Kavita library (local)
```

## Services

### blindvault-api (`:8088`)
The core identity, vault, inbox, and messaging backend. A compiled Rust/Axum binary backed by PostgreSQL 16. Handles account creation, authentication (Bearer tokens), E2EE vault blob routing (delegated to bv-blobstore), and messaging.

### bv-blobstore (`:8799`)
Content-addressable blob store (key = sha256 of ciphertext). Stores opaque ciphertext; the server never sees plaintext. Used by the API for vault files and by bv-inbox-smtp for inbox message bodies. Bearer-token protected. Zero external dependencies (pure Node.js `node:*`).

### bv-sites (`:8800`)
Neocities-style personal static sites at `<handle>.yourdomain.com`. Handles claim, WYSIWYG editor staging, upload (files or zip), DOMPurify HTML sanitisation (server-side via jsdom), and atomic publish/unpublish. JavaScript is rejected at upload and stripped from HTML at publish; nginx adds `script-src 'none'`. After publish, fires a fire-and-forget shot request to bv-shots.

### bv-board (`:8802`)
Anonymous local classifieds board. No vault login required. Post ownership is via a one-time `view_secret` (only its sha256 is stored). Supports geo-filter, image upload, flagging, and private reply mailboxes. State is a single JSON file with atomic write-and-rename. Zero external dependencies.

### bv-shots (`:8803`)
On-demand homepage screenshots for the `#/explore` directory, and PDF rendering for `#/resume`. Uses Playwright/Chromium launched on-demand (no idle browser process). Screenshots target the local, pre-sanitised, JS-disabled published site (SSRF-safe: URL is built server-side from a validated handle). Internal only; not exposed via nginx.

### bv-resume (`:8805`)
Owner-keyed resume builder backend. Stores a structured JSON model per authenticated user, sanitises the rendered HTML (DOMPurify/jsdom), publishes to `/r/<slug>`, and proxies 1-click PDF rendering to bv-shots.

### bv-route-proxy (`:8084`)
Translates `/api/route` and `/api/geocode` into calls to local Valhalla (routing) and Nominatim (geocoding). No external network dependencies at runtime if Valhalla/Nominatim are deployed locally.

### bv-download-proxy (`:8082`)
Wraps yt-dlp for the Digital Library "Save a video or song" feature. URL hostname allowlist, max file size cap (500 MB), per-job timeout, restricted filenames, single-video-only.

### bv-book-proxy (`:8083`)
Libgen search, file download, and save-to-Kavita-library proxy.

## Frontend

The frontend is a vanilla JS SPA (no framework build step; the bundle is produced by esbuild upstream, then extended by `bv-build.mjs`). Source modules live in `/root/bv-*.src.js` and route/section files in `/root/bv-*-route.js`. The build script:

1. Content-hashes and writes chunked source files to `dist/chunks/`.
2. Patches a pristine esbuild-built `main-*.js` entry point: injects nav entries, route registrations, and a small set of behavioural fixes (auto-login after registration, service worker classic mode).
3. Writes a new content-hashed `main-*.js`. Deployment then updates `index.html` to point at the new main and bumps the service worker version.

## Data Storage Layout

```
/var/lib/blindvault/       ← API state (managed by blindvault-api)
/var/lib/bv-blobstore/     ← ciphertext blobs (sha256-named files)
/var/lib/bv-sites/         ← per-handle: staging/, published/, meta.json
/var/lib/bv-board/         ← board.json + images/
/var/lib/bv-shots/thumbs/  ← <handle>.jpg preview thumbnails
/var/lib/bv-resume/        ← owners/ slugs/ shared/
/var/www/blindvault/       ← static frontend (served by nginx)
/var/lib/bv-download/      ← per-job tmp dirs (reaped after stream)
```

## Authentication Flow

```
Client                nginx            blindvault-api        bv-sites / bv-resume
  │                     │                    │                       │
  │── POST /api/login ──►                    │                       │
  │                     │──────────────────► │                       │
  │                     │◄── {token} ────────│                       │
  │◄── {token} ─────────│                    │                       │
  │                                          │                       │
  │── GET /api/sites/me ──────────────────────────────────────────► │
  │  Authorization: Bearer <token>           │                       │
  │                                          │◄── GET /api/users/me ─│
  │                                          │──── 200 OK ──────────►│
  │                                          │    (token valid)       │
  │◄───────────────────────────────────────────── {handle, ...} ─────│
```

Bearer token validation is delegated: each service calls the core API's `/api/users/me` with the client's token. The owner key used for storage is the token's first segment (the identity ID, standard base64).

## nginx Security Headers

The main app vhost sets a strict CSP (no `unsafe-eval`, no external script origins, WASM allowed), HSTS, no-referrer, COOP/CORP, and a Trusted Types report-only policy. User site subdomains get a separate hardened CSP (`script-src 'none'` effectively; user JS is stripped at publish). All services bind to `127.0.0.1` only.

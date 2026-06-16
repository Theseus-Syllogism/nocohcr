# Blindvault

A self-hosted PWA built for communities that need a secure digital home. It combines an end-to-end encrypted personal vault, encrypted email inbox, anonymous community board, personal website hosting, resume builder, and a digital library into a single installable app.

The server operator cannot read your vault files or inbox. Encryption happens in the browser before anything leaves your device.

---

## Features

### Dashboard

After logging in you land on the dashboard with quick access to everything.

![Dashboard](screenshots/dashboard.png)

---

### Encrypted Vault

Files are encrypted in your browser using a key derived from your password. The server stores only ciphertext keyed by the sha256 hash of the encrypted bytes. Nothing is readable server-side.

![Vault files](screenshots/vault-files.png)

---

### Encrypted Inbox

Incoming email is sealed to your X25519 public key at the server before storage. Only your device holds the private key needed to read it.

![Inbox](screenshots/inbox.png)

---

### Community Board

A local classifieds board that requires no account. Post resources, warnings, events, rides, free items, or anything else your community needs. When you create a post you get a one-time private key. Only someone with that key can edit, renew, or delete the post.

![Board](screenshots/board.png)
![New post](screenshots/board-new.png)

---

### Explore

Browse published community sites with live preview thumbnails generated on publish.

![Explore](screenshots/explore.png)

---

### Personal Websites

Claim a handle and get a personal site at `<handle>.yourdomain.com`. The code editor lets you write HTML and CSS directly.

![Site editor](screenshots/site-editor.png)

The WYSIWYG studio lets you drag, drop, and arrange sections without writing code. JavaScript is stripped at publish and blocked by CSP, so published sites are static HTML/CSS only.

![Studio](screenshots/studio.png)

---

### Resume Builder

Build a structured resume with a live preview. Publish it as a shareable link at `/r/your-name` or export it as a PDF.

![Resume builder](screenshots/resume-builder.png)

---

### Digital Resources

Access downloadable forms and local resource links.

![Digital resources](screenshots/digital-resources.png)

---

### Resources Directory

A curated list of local community resources and services.

![Resources](screenshots/resources.png)

---

### Forms Library

Download common legal, benefits, and government forms directly from the app.

![Forms](screenshots/forms.png)

---

### Directions

Get walking, cycling, and driving directions using a locally hosted routing engine. No data sent to Google or any third party.

![Directions](screenshots/directions.png)

---

### Emergency Info

Quick access to emergency contacts and safety information.

![Emergency](screenshots/emergency.png)

---

### Know Your Rights

A reference for legal rights and resources.

![Rights](screenshots/rights.png)

---

### Settings

Manage your account, handle, and preferences.

![Settings](screenshots/settings.png)

---

### About

![About](screenshots/about.png)

---

### Mobile

Blindvault installs as a PWA on any phone. The layout is designed for low-end devices on mobile data.

| Dashboard | Inbox | Board |
|---|---|---|
| ![Mobile dashboard](screenshots/mobile-dashboard.png) | ![Mobile inbox](screenshots/mobile-inbox.png) | ![Mobile board](screenshots/mobile-board.png) |

| Explore | Studio | Resume |
|---|---|---|
| ![Mobile explore](screenshots/mobile-explore.png) | ![Mobile studio](screenshots/mobile-studio.png) | ![Mobile resume](screenshots/mobile-resume-builder.png) |

| Resources | Directions | Emergency |
|---|---|---|
| ![Mobile resources](screenshots/mobile-resources.png) | ![Mobile directions](screenshots/mobile-directions.png) | ![Mobile emergency](screenshots/mobile-emergency.png) |

---

## Architecture

```
Browser / Mobile PWA
        |  HTTPS
        v
     nginx (edge)
        |
        +-- /var/www/blindvault/      Static frontend (SPA)
        +-- /api/*         ->  blindvault-api    :8088  (Rust/Axum + PostgreSQL)
        +-- /api/sites/*   ->  bv-sites          :8800  (Node.js)
        +-- /api/board/*   ->  bv-board          :8802  (Node.js)
        +-- /api/resume/*  ->  bv-resume         :8805  (Node.js)
        +-- /api/schedule  ->  bv-schedule       :8798  (Node.js)
        +-- /api/v1/messaging/ -> bv-messaging   :8801  (Node.js)
        +-- /api/download/ ->  bv-download-proxy :8082  (Python/yt-dlp)
        +-- /api/books/*   ->  bv-book-proxy     :8083  (Python)
        +-- /api/route     ->  bv-route-proxy    :8084  (Python/Valhalla)
        +-- /site-thumbs/  ->  /var/lib/bv-shots/thumbs/
        +-- /r/<slug>      ->  /var/lib/bv-resume/shared/
```

All backend services bind to `127.0.0.1` only. nginx is the sole public listener. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full diagram.

---

## Security

- **Vault files** are encrypted in the browser before upload. The server stores opaque ciphertext and cannot decrypt it.
- **Inbox email** is sealed to your X25519 public key before storage. The server never holds plaintext messages.
- **User sites** are sanitised server-side with DOMPurify and served with `script-src 'none'` CSP. JavaScript cannot run on published sites.
- **Board posts** require no login. Ownership is a sha256-hashed one-time secret with timing-safe comparison on every request.
- **nginx CSP** blocks all external scripts, enforces `frame-ancestors 'none'`, and runs Trusted Types in report-only mode.

See [SECURITY.md](SECURITY.md) for the full model.

---

## Self-Hosting

See [SELF-HOSTING.md](SELF-HOSTING.md) for the full guide.

Quick steps:

1. Install nginx (with `headers-more`), Node.js 20+, Python 3.11+, PostgreSQL 16
2. Run `deploy/postgres/init.sql` to create the database role
3. Copy the `blindvault-api` binary and install the systemd unit from `deploy/systemd/`
4. Start each Node.js service (`bv-sites`, `bv-board`, `bv-blobstore`, `bv-resume`, `bv-schedule`, `bv-messaging`)
5. Copy nginx configs from `deploy/nginx/` and update your domain name
6. Deploy the frontend to your web root and run `node bv-build.mjs`

Optional services that degrade gracefully if absent:

- `bv-shots` (Playwright/Chromium) -- site thumbnails and PDF export
- `bv-route-proxy` (Valhalla + Nominatim) -- directions
- `bv-download-proxy` (yt-dlp) -- video and audio download
- `bv-book-proxy` (Kavita) -- book management

---

## Building the Frontend

```bash
node bv-build.mjs

# BUILDER_CHUNK=bv-builder-XXXXXXXX.js
# NEW_MAIN=main-XXXXXXXX.js
# TO DEPLOY: point index.html at main-XXXXXXXX.js and bump the SW version.
```

See [BUILD.md](BUILD.md) for details.

---

## Repository Structure

```
frontend/
+-- bv-build.mjs              Build script
+-- bv-builder.src.js         WYSIWYG site builder (#/studio)
+-- bv-resume.src.js          Resume builder (#/resume)
+-- bv-films.src.js           Films & TV section (#/library)
+-- bv-*-route.js             Route registration modules
+-- static/                   HTML, CSS, icons, i18n, forms

services/
+-- bv-blobstore/             E2EE blob store (Node.js)
+-- bv-board/                 Anonymous community board (Node.js)
+-- bv-sites/                 User personal websites (Node.js)
+-- bv-resume/                Resume builder backend (Node.js)
+-- bv-shots/                 Screenshot and PDF renderer (Node.js/Playwright)
+-- bv-schedule/              Scheduled email send (Node.js)
+-- bv-messaging/             E2EE messaging relay (Node.js)
+-- bv-inbox-smtp/            Postfix to encrypted inbox bridge (Node.js)
+-- bv-route-proxy/           Directions proxy (Python/Valhalla)
+-- bv-download-proxy/        Video/audio download proxy (Python/yt-dlp)
+-- bv-book-proxy/            Book proxy (Python/Kavita)
+-- bv-outbox-relay/          DKIM outbound SMTP relay (Python)

deploy/
+-- nginx/                    nginx vhost configs
+-- postgres/                 Database init SQL and pg_hba snippet
+-- systemd/                  systemd unit for blindvault-api
```

---

## License

[AGPL-3.0](LICENSE)

Anyone who runs a modified version as a network service must publish their source changes under the same license.

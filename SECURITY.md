# Security Model

## Overview

Blindvault is designed so that the server operator cannot read users' vault contents. Client-side encryption means sensitive data is encrypted in the browser before transmission and decrypted after retrieval; the server stores and serves opaque ciphertext only.

## End-to-End Encryption (Vault Files)

1. **Key derivation**: a master key is derived client-side from the user's password using a strong KDF (the parameters are stored encrypted in the user's account record so they can be reconstructed at login).
2. **Encryption at the client**: files are encrypted in the browser before upload. The server receives only ciphertext blobs.
3. **Content-addressed storage**: bv-blobstore keys blobs by `sha256(ciphertext)`. The server sees the hash and the encrypted bytes; it cannot derive the plaintext.
4. **Decryption at the client**: on download the browser decrypts with the in-memory master key. The key is never sent to the server.
5. **Server cannot reconstruct**: without the user's password the operator cannot decrypt vault contents, even with full database access.

## Authentication

- Bearer tokens are issued by the core API after password verification.
- The token's first segment (the identity ID) is used as an owner key by satellite services (bv-sites, bv-resume). Its validity is confirmed by delegating to `/api/users/me` on each request; no secret is shared between services.
- Token IDs use standard base64 alphabet (`A-Za-z0-9+/`).

## Content Injection Prevention (User Sites)

User-published HTML goes through two independent layers before it can reach a browser:

1. **Server-side sanitisation**: DOMPurify (via jsdom) strips all `<script>`, `<iframe>`, `<object>`, `<embed>`, event-handler attributes, external `url()` references in CSS, `@import` rules, and `http-equiv` meta tags at publish time.
2. **nginx Content-Security-Policy**: user site subdomains are served with `script-src 'none'` (effectively; the only script allowed is the curated `/bv-widgets.js` injected at the edge, which is stored outside user directories). Even if a sanitiser sink were bypassed, the CSP enforces it at the browser.

The design principle: the sanitiser is hygiene, the CSP is the enforcement boundary.

## Resume Builder HTML Sanitisation

Published resumes receive the same DOMPurify treatment as user sites:
- Forbidden tags: `script`, `noscript`, `template`, `iframe`, `object`, `embed`, `base`, `form`.
- Forbidden attributes: `http-equiv`, `ping`, `formaction`, `srcdoc`.
- External URLs stripped from `href` and CSS.
- Published share pages (`/r/<slug>`) are served with a strict `script-src 'none'` CSP.

## Community Board

The board is intentionally anonymous; no vault login. Post ownership is a one-time `view_secret` returned at creation time (the "private link key"). Only `sha256(secret)` is stored on the server. Secret comparison uses `timingSafeEqual` to prevent timing attacks.

## Rate Limiting

nginx applies two limit zones:
- `bv_static`: 2000 req/s per IP for static assets (sized for the SPA's large cold-load fan-out of 500–700 near-simultaneous module fetches on mobile).
- `bv_api`: 40 req/s per IP for API calls.
- `bv_download`: 12 req/min per IP for yt-dlp job starts (CPU/egress abuse control).

bv-board adds in-process per-IP sliding-window rate limits per action (e.g. 10 posts/hour, 20 replies/hour).

## Service Isolation

- Every service binds to `127.0.0.1` only; nginx is the sole public listener.
- The blindvault-api systemd unit applies aggressive hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `MemoryDenyWriteExecute`, capability bounding set dropped to empty, `@privileged`/`@resources`/`@mount` syscall filters blocked.
- PostgreSQL accepts only TLS loopback connections with scram-sha-256 authentication.
- bv-blobstore never logs the Bearer token.
- bv-shots builds screenshot URLs server-side from validated handles, preventing SSRF.

## Main App CSP

The PWA is served with:
```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval' '<importmap-hash>';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://tile.openstreetmap.org ...;
  connect-src 'self' blob: https://tile.openstreetmap.org ...;
  worker-src 'self';
  font-src 'self';
  media-src 'self' blob: https://archive.org ...;
  frame-ancestors 'none';
  base-uri 'none';
  form-action 'self';
```

`'wasm-unsafe-eval'` is required by the PDF.js viewer. A Trusted Types policy is in REPORT-ONLY mode (to migrate to enforcement, change to `require-trusted-types-for 'script'` without a bundle redeploy).

Additional headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.

## What the Server Cannot See

| Data | Encrypted? | Server sees |
|------|-----------|-------------|
| Vault file contents | Yes (client-side) | Ciphertext blob + sha256 hash |
| Vault file names | Yes (client-side) | Encrypted metadata only |
| User password | Never sent | KDF-derived verifier only |
| Community board posts | No (plaintext) | Full content |
| Published user sites | No (but sanitised) | Sanitised HTML |
| Resume content | No (but sanitised) | Sanitised HTML |

## Reporting Vulnerabilities

Please report security issues privately before disclosure. Open an issue marked `[SECURITY]` on the GitHub repository and the maintainers will respond within 72 hours.

# Self-Hosting Guide

## Requirements

- Linux server (Debian/Ubuntu recommended)
- nginx with `headers-more` module (`nginx-extras` package or compiled-in)
- Node.js 20+
- Python 3.11+
- PostgreSQL 16
- A domain name with DNS control (wildcard subdomain needed for user sites)
- TLS certificates: a regular cert for the main domain and a wildcard cert for user site subdomains

Optional (for full feature set):
- Playwright/Chromium (bv-shots: site thumbnails and PDF export)
- Valhalla routing engine + Nominatim geocoder (directions feature)
- yt-dlp in a Python venv (Digital Library video/audio download)
- Kavita (Digital Library book management)

---

## 1. User and Directory Setup

```bash
# Create the service user
useradd --system --no-create-home --shell /usr/sbin/nologin blindvault

# Create state directories
mkdir -p \
  /var/lib/blindvault \
  /var/lib/bv-blobstore \
  /var/lib/bv-sites \
  /var/lib/bv-board/images \
  /var/lib/bv-shots/thumbs \
  /var/lib/bv-resume/owners \
  /var/lib/bv-resume/slugs \
  /var/lib/bv-resume/shared

chown blindvault:blindvault /var/lib/blindvault
chmod 700 /var/lib/blindvault
```

---

## 2. PostgreSQL

```bash
apt install postgresql-16

# Run as the postgres superuser. The script reads BLINDVAULT_DB_PASSWORD from env.
export BLINDVAULT_DB_PASSWORD="$(openssl rand -hex 32)"
sudo -u postgres psql -f deploy/postgres/init.sql

# Append the TLS-only auth rules
sudo cat deploy/postgres/pg_hba.conf.snippet >> /etc/postgresql/16/main/pg_hba.conf
sudo systemctl reload postgresql
```

---

## 3. Core API (blindvault-api)

The core API is a compiled Rust binary. Pre-built binaries are provided in releases; to build from source see the API source repository.

```bash
cp bin/blindvault-api /opt/blindvault/bin/blindvault-api
chmod 755 /opt/blindvault/bin/blindvault-api

# Create the environment file
mkdir -p /etc/blindvault
cat > /etc/blindvault/api.env <<'EOF'
DATABASE_URL=postgresql://blindvault:CHANGE_ME@127.0.0.1:5432/blindvault?sslmode=require
BLOBSTORE_URL=http://127.0.0.1:8799
BLOBSTORE_TOKEN=CHANGE_ME
BLINDVAULT_SECRET_KEY=CHANGE_ME_64_HEX_CHARS
BLINDVAULT_LISTEN=127.0.0.1:8088
EOF
chmod 640 /etc/blindvault/api.env
chown root:blindvault /etc/blindvault/api.env

# Install and start systemd unit
cp deploy/systemd/blindvault-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now blindvault-api
```

---

## 4. bv-blobstore

```bash
cd services/bv-blobstore
# No npm dependencies: pure Node.js

cat > /etc/systemd/system/bv-blobstore.service <<'EOF'
[Unit]
Description=bv-blobstore (E2EE vault blob store)
After=network.target

[Service]
Type=simple
User=blindvault
EnvironmentFile=/etc/blindvault/blobstore.env
ExecStart=/usr/bin/node /opt/bv-blobstore/server.mjs
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bv-blobstore

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/blindvault/blobstore.env <<'EOF'
BLOBSTORE_DIR=/var/lib/bv-blobstore
BLOBSTORE_TOKEN=CHANGE_ME   # must match api.env BLOBSTORE_TOKEN
BLOBSTORE_PORT=8799
BLOBSTORE_MAX_BYTES=8388608
EOF

systemctl daemon-reload
systemctl enable --now bv-blobstore
```

---

## 5. bv-sites

```bash
cd services/bv-sites
npm ci --omit=dev

cat > /etc/systemd/system/bv-sites.service <<'EOF'
[Unit]
Description=bv-sites (user static sites)
After=network.target

[Service]
Type=simple
User=blindvault
EnvironmentFile=/etc/blindvault/sites.env
ExecStart=/usr/bin/node /opt/bv-sites/server.mjs
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bv-sites

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/blindvault/sites.env <<'EOF'
SITES_PORT=8800
SITES_DIR=/var/lib/bv-sites
API_BASE=http://127.0.0.1:8088
BASE_DOMAIN=yourdomain.com
SHOTS_URL=http://127.0.0.1:8803
SHOTS_TOKEN=CHANGE_ME
EOF

systemctl daemon-reload
systemctl enable --now bv-sites
```

---

## 6. bv-board

```bash
cd services/bv-board
# No npm dependencies

cat > /etc/systemd/system/bv-board.service <<'EOF'
[Unit]
Description=bv-board (community board)
After=network.target

[Service]
Type=simple
User=blindvault
EnvironmentFile=/etc/blindvault/board.env
ExecStart=/usr/bin/node /opt/bv-board/server.mjs
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bv-board

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/blindvault/board.env <<'EOF'
BOARD_PORT=8802
BOARD_DIR=/var/lib/bv-board
BOARD_TTL_DAYS=30
BOARD_RENEW_DAYS=7
BOARD_MAX_IMAGE_BYTES=8388608
BOARD_FLAGS_TO_HIDE=3
EOF

systemctl daemon-reload
systemctl enable --now bv-board
```

---

## 7. bv-resume

```bash
cd services/bv-resume
npm ci --omit=dev

cat > /etc/systemd/system/bv-resume.service <<'EOF'
[Unit]
Description=bv-resume (resume builder)
After=network.target

[Service]
Type=simple
User=blindvault
EnvironmentFile=/etc/blindvault/resume.env
ExecStart=/usr/bin/node /opt/bv-resume/server.mjs
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bv-resume

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/blindvault/resume.env <<'EOF'
RESUME_PORT=8805
RESUME_DIR=/var/lib/bv-resume
API_BASE=http://127.0.0.1:8088
BASE_DOMAIN=yourdomain.com
SHOTS_URL=http://127.0.0.1:8803
SHOTS_TOKEN=CHANGE_ME
EOF

systemctl daemon-reload
systemctl enable --now bv-resume
```

---

## 8. bv-shots (Optional: site thumbnails + PDF export)

bv-shots requires Playwright with Chromium.

```bash
cd services/bv-shots
npm ci
npx playwright install chromium

cat > /etc/systemd/system/bv-shots.service <<'EOF'
[Unit]
Description=bv-shots (screenshots + PDF)
After=network.target

[Service]
Type=simple
User=blindvault
EnvironmentFile=/etc/blindvault/shots.env
ExecStart=/usr/bin/node /opt/bv-shots/server.mjs
Restart=on-failure
NoNewPrivileges=yes
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/blindvault/shots.env <<'EOF'
SHOTS_PORT=8803
SHOTS_TOKEN=CHANGE_ME   # must match sites.env and resume.env
SHOTS_DIR=/var/lib/bv-shots/thumbs
BASE_DOMAIN=yourdomain.com
SHOTS_WIDTH=1024
SHOTS_HEIGHT=768
SHOTS_QUALITY=72
EOF

systemctl daemon-reload
systemctl enable --now bv-shots
```

If you skip bv-shots, site thumbnails in the Explore directory will be absent and the resume PDF button will return 503.

---

## 9. nginx

Replace `yourdomain.com` throughout the config files before copying.

```bash
# Install nginx with headers-more support
apt install nginx-extras

# Copy config
cp deploy/nginx/blindvault.conf /etc/nginx/conf.d/blindvault.conf
cp deploy/nginx/blindvault-usersites.conf /etc/nginx/conf.d/blindvault-usersites.conf
cp deploy/nginx/ssl-params.conf /etc/nginx/snippets/ssl-params.conf

# Obtain TLS certs (requires DNS pointing at this server first)
certbot certonly --webroot -w /var/www/_acme -d yourdomain.com -d www.yourdomain.com
# Wildcard cert for user sites (requires DNS-01 challenge)
certbot certonly --manual --preferred-challenges dns -d '*.yourdomain.com'

nginx -t && systemctl reload nginx
```

### User Sites DNS

For user sites at `<handle>.yourdomain.com` you need:
- A wildcard DNS record: `*.yourdomain.com → your server IP`
- A wildcard TLS certificate (Let's Encrypt via DNS-01 challenge, e.g. with `certbot` + your DNS provider's plugin)

---

## 10. Frontend Deployment

The frontend is served as static files from `/var/www/blindvault/`. Copy the `frontend/` directory from the repository to the web root, then run the build script to patch and extend the base bundle.

```bash
cp -r frontend/static/* /var/www/blindvault/

# Install the bv-widgets runtime used on user sites
cp frontend/bv-widgets.js /var/www/bv-widgets/

# Build (requires the pre-built base bundle in dist/)
cd /root  # or wherever the source files are
node bv-build.mjs
# Output:
#   BUILDER_CHUNK=bv-builder-XXXXXXXX.js
#   NEW_MAIN=main-XXXXXXXX.js
#   TO DEPLOY: point index.html at main-XXXXXXXX.js and bump the SW version.

# Update index.html to reference the new main filename, then reload nginx
```

---

## 11. Health Checks

```bash
curl http://127.0.0.1:8088/api/health     # core API
curl http://127.0.0.1:8799/list -H "Authorization: Bearer $TOKEN"  # blobstore
curl http://127.0.0.1:8800/api/sites/health  # bv-sites
curl http://127.0.0.1:8802/api/board/health  # bv-board
curl http://127.0.0.1:8803/health            # bv-shots
curl http://127.0.0.1:8805/api/resume/health # bv-resume
```

---

## Environment Variable Reference

| Variable | Service | Description |
|---|---|---|
| `DATABASE_URL` | blindvault-api | PostgreSQL connection string |
| `BLOBSTORE_TOKEN` | blobstore, api | Shared Bearer secret |
| `BLINDVAULT_SECRET_KEY` | blindvault-api | Session signing key (64 hex chars) |
| `SITES_DIR` | bv-sites | Path to per-handle site directories |
| `BASE_DOMAIN` | bv-sites, bv-resume | Your domain (e.g. `yourdomain.com`) |
| `SHOTS_TOKEN` | bv-shots, bv-sites, bv-resume | Shared Bearer secret for screenshot/PDF service |
| `BOARD_DIR` | bv-board | Path to board state directory |
| `RESUME_DIR` | bv-resume | Path to resume state directory |
| `SHOTS_DIR` | bv-shots | Path to thumbnail output directory |

---

## Minimal Deployment (No Optional Services)

If you want to run Blindvault without directions, video download, or book library, you can skip:
- bv-route-proxy (Valhalla, Nominatim)
- bv-download-proxy (yt-dlp)
- bv-book-proxy (Kavita)
- bv-shots (Playwright/Chromium)

The PWA degrades gracefully; those sections show a "service unavailable" state rather than crashing.

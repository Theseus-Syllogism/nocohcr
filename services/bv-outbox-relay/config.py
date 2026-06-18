"""
Configuration for bv-outbox-relay — loaded entirely from environment variables.
"""

from __future__ import annotations

import os


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


# ---- Dormancy gate ----------------------------------------------------------
INBOX_ENABLED: str = _env("INBOX_ENABLED", "0")

# ---- HTTP listener (accepts outbox relay requests from the API) -------------
RELAY_HOST: str = _env("BV_RELAY_HOST", "127.0.0.1")
RELAY_PORT: int = _int("BV_RELAY_PORT", 8797)

# ---- Authentication (same env name mirrors the inbox token for simplicity) --
INTERNAL_TOKEN: str = _env("BV_OUTBOX_INTERNAL_TOKEN", "")

# ---- Transactional email sender identity ------------------------------------
# Used by /transactional (account recovery, email confirmation). The address
# must match the DKIM signing domain or upstream MX servers will reject as
# DMARC fail. Default mirrors the production tenant.
FROM_ADDRESS: str = _env("BV_FROM_ADDRESS", "noreply@yourdomain.com")
FROM_NAME:    str = _env("BV_FROM_NAME",    "BlindvaultVault")

# ---- API back-end -----------------------------------------------------------
API_BASE: str = _env("BV_OUTBOX_API_BASE", "http://127.0.0.1:8080")
API_MARK_SENT_URL: str = f"{API_BASE}/api/outbox/internal/mark-sent"

# ---- Outbound SMTP relay (the VPS Postfix submission endpoint) ---------------
# Typically the VPS public IP or hostname, port 587.
SMTP_RELAY_HOST: str = _env("BV_SMTP_RELAY_HOST", "127.0.0.1")
SMTP_RELAY_PORT: int = _int("BV_SMTP_RELAY_PORT", 587)

# ---- DKIM signing -----------------------------------------------------------
# Path to the RSA-2048 private key file (PEM).
DKIM_PRIVATE_KEY_PATH: str = _env(
    "BV_DKIM_PRIVATE_KEY_PATH", "/etc/blindvault/dkim/bv1.private"
)
# DNS selector and signing domain.
DKIM_SELECTOR: str = _env("BV_DKIM_SELECTOR", "bv1")
DKIM_DOMAIN: str = _env("BV_DKIM_DOMAIN", "blindvault.app")

# EHLO/HELO name used when delivering to remote MX hosts. MUST match the
# sending IP's PTR (reverse DNS) for forward-confirmed rDNS — generic VPS
# hostnames (e.g. generic VPS hostnames) are penalised by strict filters
# (Proton rejected mail with "550 5.7.0 Rejected by spam filter").
EHLO_NAME: str = _env("BV_RELAY_EHLO", "mail.yourdomain.com")

# ---- Limits -----------------------------------------------------------------
# Maximum raw MIME body accepted per relay request (bytes).  Default 25 MiB.
MAX_MESSAGE_BYTES: int = _int("BV_RELAY_MAX_MESSAGE_BYTES", 25 * 1024 * 1024)

"""
bv-outbox-relay — outbound SMTP relay for blindvault.

Accepts a POST /relay request from the API layer, DKIM-signs the MIME
payload, looks up MX records for each recipient, and delivers via STARTTLS
SMTP.  On success, POSTs back to {API}/api/outbox/internal/mark-sent.

Design invariants:
  - Plaintext MIME bytes are NEVER written to disk, logged, or stored in the DB.
  - DKIM signing happens in memory; the private key file is read once at startup.
  - Failed sends produce a stub DSN note (a full sealed DSN would require sealing
    it to the sender's enc_pubkey — that path is marked TODO below).
  - Dormancy: the process exits cleanly unless INBOX_ENABLED=1.

Wire contract (POST /relay):
    {
      "outbox_id": "<uuid or opaque id>",
      "mime_b64":  "<standard base64 of the raw MIME bytes>",
      "rcpts":     ["user@example.com", ...]
    }
    Authorization: Bearer <BV_OUTBOX_INTERNAL_TOKEN>

Response:
    {"delivered": true}  on full success
    {"delivered": false, "error": "..."}  on failure

The caller (API layer) retries on non-2xx with back-off.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import email as _email
import email.mime.multipart
import email.mime.text
import email.policy
import email.utils
import smtplib
import ssl
import sys
from typing import Any

import aiohttp
from aiohttp import web

import config

# ---------------------------------------------------------------------------
# DKIM signer (dkimpy)
# ---------------------------------------------------------------------------

_DKIM_SIGNER: Any = None


def _load_dkim_key() -> None:
    global _DKIM_SIGNER
    try:
        import dkim

        with open(config.DKIM_PRIVATE_KEY_PATH, "rb") as fh:
            private_key = fh.read()

        # Pre-build a partial signer config; actual signing happens per message.
        _DKIM_SIGNER = {
            "private_key": private_key,
            "selector": config.DKIM_SELECTOR.encode(),
            "domain": config.DKIM_DOMAIN.encode(),
            "include_headers": [
                b"From",
                b"To",
                b"Cc",
                b"Subject",
                b"Date",
                b"Message-ID",
                b"MIME-Version",
                b"Content-Type",
            ],
        }
        print(
            f"[dkim] loaded key from {config.DKIM_PRIVATE_KEY_PATH} "
            f"selector={config.DKIM_SELECTOR} domain={config.DKIM_DOMAIN}",
            file=sys.stderr,
        )
    except ImportError:
        print(
            "[dkim] WARNING: dkimpy not installed — outbound mail will NOT be DKIM-signed",
            file=sys.stderr,
        )
        _DKIM_SIGNER = None
    except FileNotFoundError:
        print(
            f"[dkim] WARNING: DKIM key not found at {config.DKIM_PRIVATE_KEY_PATH} "
            "— outbound mail will NOT be DKIM-signed",
            file=sys.stderr,
        )
        _DKIM_SIGNER = None


def _dkim_sign(raw_mime: bytes) -> bytes:
    """Return raw_mime with a DKIM-Signature prepended, or raw_mime unchanged."""
    if _DKIM_SIGNER is None:
        return raw_mime
    try:
        import dkim

        sig = dkim.sign(
            message=raw_mime,
            selector=_DKIM_SIGNER["selector"],
            domain=_DKIM_SIGNER["domain"],
            privkey=_DKIM_SIGNER["private_key"],
            include_headers=_DKIM_SIGNER["include_headers"],
        )
        # sig is bytes containing "DKIM-Signature: ...\r\n"; prepend to message
        return sig + raw_mime
    except Exception as exc:  # noqa: BLE001
        print(f"[dkim] signing failed: {exc}", file=sys.stderr)
        return raw_mime


# ---------------------------------------------------------------------------
# MX lookup (dnspython)
# ---------------------------------------------------------------------------

def _lookup_mx(domain: str) -> list[str]:
    """Return a list of MX host names sorted by preference (lowest first)."""
    try:
        import dns.resolver

        answers = dns.resolver.resolve(domain, "MX")
        sorted_rdata = sorted(answers, key=lambda r: r.preference)
        return [str(r.exchange).rstrip(".") for r in sorted_rdata]
    except ImportError:
        # Fallback: just try the domain itself as an A record
        return [domain]
    except Exception as exc:  # noqa: BLE001
        print(f"[mx] DNS lookup failed for {domain}: {exc}", file=sys.stderr)
        return [domain]


# ---------------------------------------------------------------------------
# SMTP delivery (synchronous, run in executor to avoid blocking the loop)
# ---------------------------------------------------------------------------

def _deliver_smtp_sync(signed_mime: bytes, sender: str, rcpts: list[str]) -> None:
    """
    Open a STARTTLS SMTP connection to each recipient's MX host and deliver.

    Raises RuntimeError on complete failure.  On partial failure (some rcpts
    rejected) the successfully delivered recipients are still committed.
    """
    # Group by receiving domain
    by_domain: dict[str, list[str]] = {}
    for rcpt in rcpts:
        domain = rcpt.split("@", 1)[-1]
        by_domain.setdefault(domain, []).append(rcpt)

    errors: list[str] = []

    for domain, domain_rcpts in by_domain.items():
        mx_hosts = _lookup_mx(domain)
        delivered = False
        last_error = ""

        for mx in mx_hosts:
            try:
                ctx = ssl.create_default_context()
                with smtplib.SMTP(mx, 25, timeout=30, local_hostname=config.EHLO_NAME) as smtp:
                    smtp.ehlo()
                    if smtp.has_extn("STARTTLS"):
                        smtp.starttls(context=ctx)
                        smtp.ehlo()
                    smtp.sendmail(sender, domain_rcpts, signed_mime)
                delivered = True
                break
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                continue

        if not delivered:
            errors.append(f"{domain}: {last_error}")

    if errors:
        raise RuntimeError("; ".join(errors))


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

@web.middleware
async def _auth_middleware(request: web.Request, handler) -> web.Response:
    """Bearer-token authentication guard."""
    auth = request.headers.get("Authorization", "")
    expected = f"Bearer {config.INTERNAL_TOKEN}"
    # Constant-time comparison
    import hmac
    if not hmac.compare_digest(auth.encode(), expected.encode()):
        return web.Response(status=401, text="unauthorized")
    return await handler(request)


async def relay_handler(request: web.Request) -> web.Response:
    """POST /relay — receive, DKIM-sign, and deliver an outbound message."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    outbox_id = body.get("outbox_id", "")
    mime_b64 = body.get("mime_b64", "")
    rcpts: list[str] = body.get("rcpts", [])

    if not mime_b64 or not rcpts:
        return web.json_response({"error": "mime_b64 and rcpts required"}, status=400)

    # Decode MIME — never touches disk or logs
    try:
        raw_mime = base64.b64decode(mime_b64)
    except Exception:
        return web.json_response({"error": "invalid base64"}, status=400)

    if len(raw_mime) > config.MAX_MESSAGE_BYTES:
        return web.json_response({"error": "message too large"}, status=413)

    # Parse From: header for the envelope sender
    msg = _email.message_from_bytes(raw_mime, policy=email.policy.default)
    sender_header = msg.get("From", "")
    # Extract addr-spec from "Display Name <addr@example.com>" if needed
    if "<" in sender_header and ">" in sender_header:
        sender = sender_header.split("<")[1].split(">")[0].strip()
    else:
        sender = sender_header.strip()
    if not sender:
        return web.json_response({"error": "no From header"}, status=400)

    # DKIM-sign in memory
    signed_mime = _dkim_sign(raw_mime)

    # Deliver via SMTP (blocking, run in thread pool)
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(
            None, _deliver_smtp_sync, signed_mime, sender, rcpts
        )
    except RuntimeError as exc:
        error_msg = str(exc)
        print(
            f"[relay] SMTP delivery failed for outbox_id={outbox_id}: {error_msg}",
            file=sys.stderr,
        )
        # TODO: seal a DSN to sender's enc_pubkey and POST to internal/deliver
        # For now, return the error to the API for retry handling.
        return web.json_response({"delivered": False, "error": error_msg}, status=502)

    # Notify API that delivery succeeded
    if config.API_MARK_SENT_URL:
        async with aiohttp.ClientSession() as http:
            try:
                async with http.post(
                    config.API_MARK_SENT_URL,
                    json={"outbox_id": outbox_id},
                    headers={"x-bv-inbox-token": config.INTERNAL_TOKEN},
                ) as resp:
                    if not resp.ok:
                        print(
                            f"[relay] mark-sent API call failed: {resp.status}",
                            file=sys.stderr,
                        )
            except aiohttp.ClientError as exc:
                print(f"[relay] mark-sent request error: {exc}", file=sys.stderr)

    print(f"[relay] delivered outbox_id={outbox_id} rcpts={rcpts}", file=sys.stderr)
    return web.json_response({"delivered": True})


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def _build_transactional_mime(kind: str, to: str, token: str) -> bytes:
    """
    Render a DKIM-signed multipart HTML+text email for recovery flows.

    `kind` is one of "recovery_confirm" or "recovery_token"; the copy and
    expiry are tied to those (confirm = 30m, recover = 15m) so the email
    matches what the API will accept.
    """
    msg = email.mime.multipart.MIMEMultipart("alternative")
    from_hdr = f"{config.FROM_NAME} <{config.FROM_ADDRESS}>"

    if kind == "recovery_confirm":
        subject = f"Confirm your {config.FROM_NAME} recovery email"
        ttl = "30 minutes"
        instruction = "Enter this code in Settings → Account Security to activate email recovery."
        disavow = "If you didn't request this, you can safely ignore this message."
    elif kind == "recovery_token":
        subject = f"{config.FROM_NAME} account recovery code"
        ttl = "15 minutes"
        instruction = "Visit the app and choose 'Recover account' to use it."
        disavow = (
            "If you didn't request account recovery, your email may be registered "
            "on an account you don't recognise. No action was taken — you can ignore this."
        )
    else:
        raise ValueError(f"unknown transactional kind: {kind!r}")

    plain = (
        f"Your code: {token}\n"
        f"Expires in {ttl}.\n\n"
        f"{instruction}\n\n"
        f"{disavow}\n"
    )
    html = (
        f"<p>Your code: <strong>{token}</strong></p>"
        f"<p>Expires in {ttl}.</p>"
        f"<p>{instruction}</p>"
        f"<p><small>{disavow}</small></p>"
    )

    msg["From"]       = from_hdr
    msg["To"]         = to
    msg["Subject"]    = subject
    msg["Date"]       = email.utils.formatdate(usegmt=True)
    msg["Message-ID"] = email.utils.make_msgid(
        domain=config.FROM_ADDRESS.split("@")[-1]
    )

    msg.attach(email.mime.text.MIMEText(plain, "plain", "utf-8"))
    msg.attach(email.mime.text.MIMEText(
        f"<!DOCTYPE html><html><body>{html}</body></html>",
        "html", "utf-8",
    ))
    return _dkim_sign(msg.as_bytes(policy=email.policy.SMTP))


async def transactional_handler(request: web.Request) -> web.Response:
    """POST /transactional — send a system email (confirm or recovery token)."""
    try:
        body = await request.json()
        kind = body["kind"]
        to = body["to"]
        token = body["token"]
    except (ValueError, KeyError) as exc:
        return web.json_response({"error": str(exc)}, status=400)

    if not isinstance(to, str) or "@" not in to or len(to) > 320:
        return web.json_response({"error": "invalid to"}, status=400)
    if not isinstance(token, str) or not token:
        return web.json_response({"error": "invalid token"}, status=400)

    try:
        signed_mime = _build_transactional_mime(kind, to, token)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        print(f"[transactional] sign error: {exc}", file=sys.stderr)
        return web.json_response({"error": "sign_failed"}, status=500)

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(
            None, _deliver_smtp_sync, signed_mime, config.FROM_ADDRESS, [to]
        )
    except RuntimeError as exc:
        print(f"[transactional] delivery failed to {to}: {exc}", file=sys.stderr)
        return web.json_response({"sent": False, "error": str(exc)}, status=502)

    print(f"[transactional] sent kind={kind} to={to}", file=sys.stderr)
    return web.json_response({"sent": True})


def build_app() -> web.Application:
    app = web.Application(middlewares=[_auth_middleware])
    app.router.add_post("/relay", relay_handler)
    app.router.add_post("/transactional", transactional_handler)
    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if config.INBOX_ENABLED != "1":
        print(
            "bv-outbox-relay: INBOX_ENABLED is not '1' — daemon is DORMANT, exiting.",
            file=sys.stderr,
        )
        sys.exit(0)

    if not config.INTERNAL_TOKEN:
        print(
            "bv-outbox-relay: BV_OUTBOX_INTERNAL_TOKEN is not set — refusing to start.",
            file=sys.stderr,
        )
        sys.exit(1)

    _load_dkim_key()

    app = build_app()
    print(
        f"bv-outbox-relay listening on {config.RELAY_HOST}:{config.RELAY_PORT}",
        file=sys.stderr,
    )
    web.run_app(app, host=config.RELAY_HOST, port=config.RELAY_PORT, print=None)


if __name__ == "__main__":
    main()

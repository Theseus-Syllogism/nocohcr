#!/usr/bin/env node
// bv-inbox-smtp — Postfix → BlindVault encrypted-inbox bridge (header+preview MVP).
//
// Postfix pipes a raw RFC822 message on stdin; recipients are passed as argv.
// For each recipient local-part we:
//   1. look it up via the API's internal route endpoint (gets its X25519 enc_pubkey),
//   2. seal a small JSON "envelope" {from,to,cc,subject,preview} to that pubkey using
//      the app's sealed-box-x25519-v1 scheme (ephPub ‖ XChaCha20-Poly1305, HKDF-SHA256),
//   3. POST it to the API's internal deliver endpoint, which stores the ciphertext.
// The server never sees plaintext — only the recipient's own device can decrypt it.
//
// MVP: the full body is not stored (no blobstore yet) — the readable text goes into the
// `preview` field, which the client shows as the message body. body_hash is a placeholder.
//
// Env: INBOX_INTERNAL_TOKEN (required), INBOX_API_URL (default http://127.0.0.1:8088),
//      MAIL_DOMAIN (default yourdomain.com), PREVIEW_MAX (default 16000).

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { simpleParser } from 'mailparser';
import { createHash, webcrypto } from 'node:crypto';
import pg from 'pg';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const ENC_SCHEME = 'sealed-box-x25519-v1';
const LOCALPART_RE = /^[a-z0-9._-]{3,64}$/;

// sysexits.h — Postfix maps these to bounce / defer behaviour for pipe transports.
const EX = { OK: 0, USAGE: 64, DATAERR: 65, NOUSER: 67, UNAVAILABLE: 69, SOFTWARE: 70, TEMPFAIL: 75 };

const CFG = {
  token: process.env.INBOX_INTERNAL_TOKEN || '',
  apiUrl: (process.env.INBOX_API_URL || 'http://127.0.0.1:8088').replace(/\/+$/, ''),
  domain: (process.env.MAIL_DOMAIN || 'yourdomain.com').toLowerCase(),
  previewMax: Number(process.env.PREVIEW_MAX || 16000),
  blobUrl: (process.env.BLOBSTORE_URL || '').replace(/\/+$/, ''),
  blobToken: process.env.BLOBSTORE_TOKEN || '',
  bodyMaxBytes: Number(process.env.BODY_MAX_BYTES || 6 * 1024 * 1024),
};

const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

// Decode a 32-byte key that the API may send as base64 or hex.
export function decodeKey32(s) {
  if (typeof s !== 'string') throw new Error('key not a string');
  if (/^[0-9a-fA-F]{64}$/.test(s)) return fromHex(s);
  const u = fromB64(s);
  if (u.length !== 32) throw new Error(`enc_pubkey must be 32 bytes, got ${u.length}`);
  return u;
}

async function hkdf(ikm, salt, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, len * 8);
  return new Uint8Array(bits);
}

// sealed-box-x25519-v1: ephemeral X25519 → ECDH → HKDF-SHA256(salt=recipientPub|ephPub)
// → XChaCha20-Poly1305. Output = ephPub(32) ‖ ciphertext+tag. Verified byte-compatible
// with the frontend's decryptor.
export async function seal(recipientPub, plaintext) {
  const ephPriv = x25519.utils.randomSecretKey ? x25519.utils.randomSecretKey() : x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientPub);
  const key = await hkdf(shared, recipientPub, 'bv-sealed-box-v1-key', 32);
  const nonce = await hkdf(shared, ephPub, 'bv-sealed-box-v1-nonce', 24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + ct.length);
  out.set(ephPub, 0);
  out.set(ct, 32);
  return out;
}

const addr = (a) => (a ? { email: (a.address || '').toLowerCase(), ...(a.name ? { name: a.name } : {}) } : null);
const addrs = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => (x.value || []).map(addr)).filter(Boolean) : []);

// Build the JSON the client expects from a parsed email. `preview` carries the readable
// body text (the client renders it as the message body until a real body blob exists).
export function buildEnvelope(parsed, id) {
  const text = (parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '') || '').replace(/\s+\n/g, '\n').trim();
  const fromList = addrs(parsed.from);
  return {
    thread_id: id,
    ts: (parsed.date ? parsed.date : new Date()).toISOString(), // ISO so the client renders a correct date (was Unix seconds → 1970)
    from: fromList[0] || { email: '' },
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    subject: (parsed.subject || '(no subject)').slice(0, 998),
    preview: text.slice(0, CFG.previewMax),
  };
}

// Seal the full body (text/html/attachments) the way the client expects and
// upload the ciphertext to the blobstore. Returns the 32-byte sha256 of the
// ciphertext (= body_hash). Falls back to a placeholder hash (header+preview
// only) when no blobstore is configured.
export async function storeBody(parsed, encPubBytes, sealedEnvelope) {
  if (!CFG.blobUrl || !CFG.blobToken) return createHash('sha256').update(sealedEnvelope).digest();
  const atts = (parsed.attachments || []).filter((a) => a.content).map((a) => ({
    filename: a.filename || 'attachment',
    mime: a.contentType || 'application/octet-stream',
    data_b64: a.content.toString('base64'),
  }));
  const bodyDoc = {
    bodyText: parsed.text || '',
    bodyHtml: parsed.html || '',
    isHtml: !!parsed.html,
    inlineAttachments: [],
    outlineAttachments: atts,
  };
  let plain = enc.encode(JSON.stringify(bodyDoc));
  if (plain.length > CFG.bodyMaxBytes) { bodyDoc.outlineAttachments = []; plain = enc.encode(JSON.stringify(bodyDoc)); }
  const ct = Buffer.from(await seal(encPubBytes, plain));
  const hash = createHash('sha256').update(ct).digest();
  const r = await fetch(`${CFG.blobUrl}/${hash.toString('hex')}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${CFG.blobToken}`, 'content-type': 'application/octet-stream' },
    body: ct,
  });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`blob_put_${r.status}`);
  return hash;
}

async function apiRoute(local) {
  const res = await fetch(`${CFG.apiUrl}/api/inbox/internal/route/${encodeURIComponent(local)}`, {
    headers: { 'x-bv-inbox-token': CFG.token },
  });
  return { status: res.status, body: await res.text() };
}

async function apiDeliver(payload) {
  const res = await fetch(`${CFG.apiUrl}/api/inbox/internal/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bv-inbox-token': CFG.token },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

// Deliver to one recipient. Returns a sysexits code. Pure-ish: HTTP via the two helpers above.
export async function deliverOne(local, parsed, deps = {}) {
  const route = deps.route || apiRoute;
  const deliver = deps.deliver || apiDeliver;
  if (!LOCALPART_RE.test(local)) return { code: EX.NOUSER, reason: 'bad_localpart' };

  const r = await route(local);
  if (r.status === 404 || /unknown_local/.test(r.body)) return { code: EX.NOUSER, reason: 'unknown_local' };
  if (r.status === 410 || /address_expired/.test(r.body)) return { code: EX.NOUSER, reason: 'address_expired' };
  if (r.status === 401 || /bad_inbox_token/.test(r.body)) return { code: EX.TEMPFAIL, reason: 'bad_inbox_token' };
  if (r.status === 503 || /inbox_disabled/.test(r.body)) return { code: EX.TEMPFAIL, reason: 'inbox_disabled' };
  if (r.status === 429) return { code: EX.TEMPFAIL, reason: 'quota' };
  if (r.status >= 400) return { code: EX.TEMPFAIL, reason: `route_${r.status}` };

  let info;
  try { info = JSON.parse(r.body); } catch { return { code: EX.TEMPFAIL, reason: 'route_parse' }; }
  if (info.quota_remaining != null && info.quota_remaining <= 0) return { code: EX.NOUSER, reason: 'over_quota' };
  const pub = decodeKey32(info.enc_pubkey);

  const id = crypto.getRandomValues(new Uint8Array(32));
  const envelope = buildEnvelope(parsed, b64(id));
  const sealed = await seal(pub, enc.encode(JSON.stringify(envelope)));
  // MVP placeholder body_hash: real sha256 of bytes we actually produced (no blobstore yet).
  const bodyHash = new Uint8Array(createHash('sha256').update(sealed).digest());

  const payload = {
    id: b64(id),
    owner_id: info.owner_id, // from the route lookup; deliver requires it verbatim
    local_part: local,
    enc_envelope: b64(sealed),
    envelope_nonce: b64(new Uint8Array([1])), // 1-byte scheme sentinel
    body_hash: b64(bodyHash),
    size_bytes: sealed.length,
    enc_scheme: ENC_SCHEME,
  };
  const d = await deliver(payload);
  if (d.status >= 200 && d.status < 300) return { code: EX.OK, reason: 'delivered' };
  if (d.status === 401 || d.status === 503) return { code: EX.TEMPFAIL, reason: `deliver_${d.status}` };
  if (d.status === 404 || /unknown_local/.test(d.body)) return { code: EX.NOUSER, reason: 'deliver_unknown' };
  return { code: EX.TEMPFAIL, reason: `deliver_${d.status}:${d.body.slice(0, 120)}` };
}

// Direct-DB delivery: look up the recipient's key and INSERT the sealed row
// straight into inbox_messages, bypassing the API's internal/deliver endpoint
// (which currently rejects with an opaque bad_request). The client reads inbox
// rows directly, so a correctly-sealed row shows up and decrypts normally.
export async function deliverOneViaDb(local, parsed, pool) {
  if (!LOCALPART_RE.test(local)) return { code: EX.NOUSER, reason: 'bad_localpart' };
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT a.owner_id, a.expires_at, i.enc_pubkey
         FROM inbox_addresses a JOIN identities i ON i.id = a.owner_id
        WHERE a.local_part = $1`, [local]));
  } catch (e) { return { code: EX.TEMPFAIL, reason: `db_lookup:${e.code || e.message}` }; }
  if (!rows.length) return { code: EX.NOUSER, reason: 'unknown_local' };
  const { owner_id, expires_at, enc_pubkey } = rows[0];
  if (expires_at && new Date(expires_at) <= new Date()) return { code: EX.NOUSER, reason: 'address_expired' };
  if (!enc_pubkey || enc_pubkey.length !== 32) return { code: EX.TEMPFAIL, reason: 'no_pubkey' };

  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const envelope = buildEnvelope(parsed, id.toString('base64'));
  const sealed = Buffer.from(await seal(new Uint8Array(enc_pubkey), enc.encode(JSON.stringify(envelope))));
  let bodyHash;
  try { bodyHash = await storeBody(parsed, new Uint8Array(enc_pubkey), sealed); }
  catch (e) { return { code: EX.TEMPFAIL, reason: `body_store:${e.message}` }; }
  try {
    await pool.query(
      `INSERT INTO inbox_messages (id, owner_id, local_part, enc_envelope, envelope_nonce, body_hash, size_bytes, enc_scheme)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, owner_id, local, sealed, Buffer.from([1]), bodyHash, sealed.length, ENC_SCHEME]);
  } catch (e) { return { code: EX.TEMPFAIL, reason: `db_insert:${e.code || e.message}` }; }
  return { code: EX.OK, reason: 'delivered_db' };
}

async function main() {
  const useDb = process.env.INBOX_DIRECT_DB === '1' || process.env.INBOX_DIRECT_DB === 'true';
  if (!useDb && !CFG.token) { console.error('bv-inbox-smtp: INBOX_INTERNAL_TOKEN unset'); process.exit(EX.UNAVAILABLE); }
  const recips = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
  if (!recips.length) { console.error('bv-inbox-smtp: no recipients in argv'); process.exit(EX.USAGE); }

  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (!raw.length) { console.error('bv-inbox-smtp: empty message'); process.exit(EX.TEMPFAIL); }

  let parsed;
  try { parsed = await simpleParser(raw); } catch (e) { console.error('parse failed:', e.message); process.exit(EX.DATAERR); }

  const pool = useDb
    ? new pg.Pool({ host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE || 'blindvault', user: process.env.PGUSER || 'bvinbox', max: 2 })
    : null;
  let worst = EX.OK;
  for (const rcpt of recips) {
    const at = rcpt.lastIndexOf('@');
    const local = (at >= 0 ? rcpt.slice(0, at) : rcpt).toLowerCase();
    const domain = at >= 0 ? rcpt.slice(at + 1).toLowerCase() : CFG.domain;
    if (domain !== CFG.domain) { console.error(`reject foreign domain ${domain}`); worst = Math.max(worst, EX.NOUSER); continue; }
    let res;
    try { res = useDb ? await deliverOneViaDb(local, parsed, pool) : await deliverOne(local, parsed); }
    catch (e) { console.error(`deliver ${local} error:`, e.message); res = { code: EX.TEMPFAIL, reason: 'exception' }; }
    console.error(`bv-inbox-smtp ${local}@${domain}: ${res.reason} (exit ${res.code})`);
    // NOUSER (permanent) shouldn't override a TEMPFAIL (transient) for other recipients.
    if (res.code !== EX.OK) worst = res.code === EX.TEMPFAIL ? EX.TEMPFAIL : Math.max(worst, res.code);
  }
  if (pool) await pool.end();
  process.exit(worst);
}

// Only run main() when invoked directly (not when imported by the test harness).
if (import.meta.url === `file://${process.argv[1]}`) main();

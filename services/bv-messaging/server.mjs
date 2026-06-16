// bv-messaging — zero-knowledge relay for Blindvault app-to-app messaging.
//
// Implements the wire contract the (already-shipped) SPA calls. The client
// silently "mocks" these endpoints on 404/501; once they return 2xx it uses
// the real network path automatically (`if (res.ok) return { mocked:false }`).
//
// The relay stores ONLY opaque material:
//   - public Olm bundles  (identity_keys + one-time curve25519 prekeys)
//   - sealed envelopes     (ciphertext routed by recipient_identity_id)
//   - attachment blobs      (opaque bytes)
// It never sees plaintext and holds no private keys. Auth is delegated to the
// main API: the caller's Bearer token is forwarded to /api/users/me (200 =>
// valid); the owner id is the token's id-segment (same scheme as bv-sites).
//
// Routes (all under /api/v1/messaging/, proxied by nginx):
//   GET    /health
//   POST   /account                 body: {identity_keys, prekeys:{curve25519:{id:key}}, ...}
//   GET    /account                 -> caller's own published bundle
//   GET    /account/:identityId     -> peer bundle + claims one one-time key
//   POST   /envelope                body: {recipient_identity_id, ciphertext, ...}
//   GET    /envelope?since=<seq>    -> {envelopes:[...], cursor}
//   DELETE /envelope?upto=<seq>     -> acks (deletes) delivered envelopes
//   POST   /attachments/:id         -> register (+store if body) -> {url}
//   PUT    /attachments/:id         -> store opaque bytes
//   GET    /attachments/:id         -> opaque bytes

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CFG = {
  port:        parseInt(process.env.MESSAGING_PORT || '8801', 10),
  apiBase:     process.env.API_BASE || 'http://127.0.0.1:8088',
  dir:         process.env.DATA_DIR || '/var/lib/bv-messaging',
  maxBody:     parseInt(process.env.MAX_ENVELOPE_BYTES || '262144', 10),    // 256 KiB / envelope
  maxQueue:    parseInt(process.env.MAX_QUEUE_PER_RECIPIENT || '2000', 10),
  maxAtt:      parseInt(process.env.MAX_ATTACHMENT_BYTES || '10485760', 10), // 10 MiB
};
const ACCOUNTS = `${CFG.dir}/accounts`;
const OWNERS   = `${CFG.dir}/owners`;
const ENVS     = `${CFG.dir}/envelopes`;
const ATTS     = `${CFG.dir}/attachments`;

// ---- helpers --------------------------------------------------------------
const J = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const idOk = (s) => typeof s === 'string' && s.length >= 10 && s.length <= 256;

async function readBody(req, cap = CFG.maxBody) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > cap) throw new Error('too_large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, cap = CFG.maxBody) {
  const buf = await readBody(req, cap);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// Auth: forward the Bearer to the main API; owner = token id-segment.
async function authOwner(req) {
  const auth = req.headers['authorization'];
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  let r;
  try { r = await fetch(`${CFG.apiBase}/api/users/me`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) }); }
  catch { return null; }
  if (!r.ok) return null;
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const owner = token.split('.')[0];
  return owner && owner.length >= 8 && owner.length <= 200 && /^[A-Za-z0-9._~-]+$/.test(owner) ? owner : null;
}

// Identity id (routing key) = the curve25519 identity key from the bundle.
function deriveIdentityId(bundle) {
  let ik = bundle && bundle.identity_keys;
  if (typeof ik === 'string') { try { ik = JSON.parse(ik); } catch { ik = null; } }
  const id = ik && (ik.curve25519 || ik.curve25519Key || ik.ed25519);
  return idOk(id) ? id : null;
}

const accFile = (identityId) => `${ACCOUNTS}/${sha(identityId)}.json`;
const ownerFile = (owner) => `${OWNERS}/${sha(owner)}`;
const envDir = (identityId) => `${ENVS}/${sha(identityId)}`;
const attFile = (id) => `${ATTS}/${sha(id)}`;

const loadJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const resolveOwnerIdentity = async (owner) => { try { return (await readFile(ownerFile(owner), 'utf8')).trim() || null; } catch { return null; } };

// In-process monotonic sequence per recipient (single Node process).
const seqCache = new Map();
async function nextSeq(identityId) {
  const key = sha(identityId);
  if (!seqCache.has(key)) {
    let max = 0;
    try {
      for (const f of await readdir(envDir(identityId))) {
        const m = /^(\d+)\.json$/.exec(f); if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch { /* no dir yet */ }
    seqCache.set(key, max);
  }
  const next = seqCache.get(key) + 1;
  seqCache.set(key, next);
  return next;
}

// ---- handlers -------------------------------------------------------------
async function putAccount(owner, body) {
  const identityId = deriveIdentityId(body);
  if (!identityId) return { code: 400, body: { error: 'bad_bundle' } };
  if (!body.prekeys || typeof body.prekeys !== 'object') body.prekeys = { curve25519: {} };
  await mkdir(ACCOUNTS, { recursive: true, mode: 0o750 });
  await mkdir(OWNERS, { recursive: true, mode: 0o750 });
  const now = new Date().toISOString();
  const prev = await loadJson(accFile(identityId));
  const rec = { identity_id: identityId, owner, bundle: { ...body, uploaded_at: body.uploaded_at || now }, created_at: prev?.created_at || now, updated_at: now };
  await writeFile(accFile(identityId), JSON.stringify(rec), { mode: 0o640 });
  await writeFile(ownerFile(owner), identityId, { mode: 0o640 }); // bind owner -> identity (latest wins)
  return { code: 200, body: { ok: true, identity_id: identityId } };
}

async function getOwnAccount(owner) {
  const identityId = await resolveOwnerIdentity(owner);
  if (!identityId) return { code: 404, body: { error: 'no_account' } };
  const rec = await loadJson(accFile(identityId));
  if (!rec) return { code: 404, body: { error: 'no_account' } };
  return { code: 200, body: rec.bundle };   // client expects the bundle object verbatim
}

// Peer bundle: return identity keys + claim (consume) one one-time prekey.
async function getPeerBundle(identityId) {
  const rec = await loadJson(accFile(identityId));
  if (!rec) return { code: 404, body: { error: 'unknown_peer' } };
  const otks = (rec.bundle.prekeys && rec.bundle.prekeys.curve25519) || {};
  const ids = Object.keys(otks);
  let one_time_key = null;
  if (ids.length) {
    const kid = ids[0];
    one_time_key = { id: kid, key: otks[kid] };
    delete otks[kid];                                   // consume so it is never reused
    rec.updated_at = new Date().toISOString();
    await writeFile(accFile(identityId), JSON.stringify(rec), { mode: 0o640 });
  }
  return { code: 200, body: { identity_keys: rec.bundle.identity_keys, one_time_key } };
}

async function postEnvelope(owner, body) {
  const to = body && body.recipient_identity_id;
  if (!idOk(to)) return { code: 400, body: { error: 'bad_recipient' } };
  const dir = envDir(to);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  // enforce a simple per-recipient queue cap (drop oldest)
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (files.length >= CFG.maxQueue) {
      for (const f of files.slice(0, files.length - CFG.maxQueue + 1)) await rm(`${dir}/${f}`, { force: true });
    }
  } catch { /* ignore */ }
  const seq = await nextSeq(to);
  const stored = { seq, received_at: new Date().toISOString(), envelope: body };
  await writeFile(`${dir}/${String(seq).padStart(12, '0')}.json`, JSON.stringify(stored), { mode: 0o640 });
  return { code: 200, body: { ok: true, envelope_id: body.envelope_id || null, seq } };
}

async function listEnvelopes(owner, sinceSeq) {
  const identityId = await resolveOwnerIdentity(owner);
  if (!identityId) return { code: 200, body: { envelopes: [], cursor: sinceSeq } };
  const dir = envDir(identityId);
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)).sort(); } catch { return { code: 200, body: { envelopes: [], cursor: sinceSeq } }; }
  const out = []; let cursor = sinceSeq;
  for (const f of files) {
    const seq = parseInt(f, 10);
    if (seq <= sinceSeq) continue;
    const rec = await loadJson(`${dir}/${f}`);
    if (rec) { out.push({ seq: rec.seq, received_at: rec.received_at, ...rec.envelope }); cursor = Math.max(cursor, rec.seq); }
    if (out.length >= 200) break;       // page
  }
  return { code: 200, body: { envelopes: out, cursor } };
}

async function ackEnvelopes(owner, uptoSeq) {
  const identityId = await resolveOwnerIdentity(owner);
  if (!identityId) return { code: 200, body: { deleted: 0 } };
  const dir = envDir(identityId);
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)); } catch { return { code: 200, body: { deleted: 0 } }; }
  let deleted = 0;
  for (const f of files) { if (parseInt(f, 10) <= uptoSeq) { await rm(`${dir}/${f}`, { force: true }); deleted++; } }
  return { code: 200, body: { deleted } };
}

async function putAttachment(id, buf) {
  await mkdir(ATTS, { recursive: true, mode: 0o750 });
  await writeFile(attFile(id), buf, { mode: 0o640 });
}
async function getAttachment(id) {
  try { return await readFile(attFile(id)); } catch { return null; }
}

// ---- router ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const m = req.method;
    if (!p.startsWith('/api/v1/messaging/')) return J(res, 404, { error: 'not_found' });
    if (m === 'GET' && p === '/api/v1/messaging/health') return J(res, 200, { ok: true });

    const owner = await authOwner(req);
    if (!owner) return J(res, 401, { error: 'AUTH_REQUIRED' });

    // account
    if (p === '/api/v1/messaging/account') {
      if (m === 'POST') { const r = await putAccount(owner, await readJson(req)); return J(res, r.code, r.body); }
      if (m === 'GET')  { const r = await getOwnAccount(owner); return J(res, r.code, r.body); }
      return J(res, 405, { error: 'method' });
    }
    let mm;
    if ((mm = /^\/api\/v1\/messaging\/account\/(.+)$/.exec(p))) {
      if (m !== 'GET') return J(res, 405, { error: 'method' });
      const r = await getPeerBundle(decodeURIComponent(mm[1])); return J(res, r.code, r.body);
    }

    // envelope
    if (p === '/api/v1/messaging/envelope') {
      if (m === 'POST')   { const r = await postEnvelope(owner, await readJson(req)); return J(res, r.code, r.body); }
      if (m === 'GET')    { const r = await listEnvelopes(owner, parseInt(u.searchParams.get('since') || '0', 10) || 0); return J(res, r.code, r.body); }
      if (m === 'DELETE') { const r = await ackEnvelopes(owner, parseInt(u.searchParams.get('upto') || '0', 10) || 0); return J(res, r.code, r.body); }
      return J(res, 405, { error: 'method' });
    }

    // attachments
    if ((mm = /^\/api\/v1\/messaging\/attachments\/(.+)$/.exec(p))) {
      const id = decodeURIComponent(mm[1]);
      if (!idOk(id)) return J(res, 400, { error: 'bad_id' });
      if (m === 'GET')  { const buf = await getAttachment(id); if (!buf) return J(res, 404, { error: 'not_found' }); res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); return res.end(buf); }
      if (m === 'PUT')  { await putAttachment(id, await readBody(req, CFG.maxAtt)); return J(res, 200, { ok: true, url: `/api/v1/messaging/attachments/${encodeURIComponent(id)}` }); }
      if (m === 'POST') { const buf = await readBody(req, CFG.maxAtt).catch(() => Buffer.alloc(0)); if (buf.length) await putAttachment(id, buf); return J(res, 200, { ok: true, url: `/api/v1/messaging/attachments/${encodeURIComponent(id)}` }); }
      return J(res, 405, { error: 'method' });
    }

    return J(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e && e.message === 'too_large') return J(res, 413, { error: 'too_large' });
    if (e instanceof SyntaxError)       return J(res, 400, { error: 'bad_json' });
    return J(res, 500, { error: 'server_error' });
  }
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ msg: 'bv-messaging listening', addr: `127.0.0.1:${CFG.port}`, apiBase: CFG.apiBase }));
});

#!/usr/bin/env node
// bv-schedule — server-side scheduled-send for the BlindVault mailbox.
//
// The compiled API can't schedule, so the client POSTs a scheduled send here.
// We authenticate by DELEGATING the client's Bearer token to the API's
// /api/users/me (200 => the token is valid and its id-segment is the
// authenticated identity). The send is stored on disk; a worker builds the
// RFC822 MIME at the scheduled time and posts it to the outbound relay
// (which DKIM-signs + delivers) — so it sends even if the app is closed.
//
// Routes (fronted same-origin by nginx):
//   POST /api/schedule            {from_local,to[],cc[],bcc[],subject,text,html?,attachments[]?,send_at}
//   GET  /api/scheduled           -> [{id,send_at,to,cc,subject,created_at}]
//   POST /api/scheduled/cancel    {id}

import http from 'node:http';
import { readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const CFG = {
  port: Number(process.env.SCHED_PORT || 8798),
  apiBase: (process.env.API_BASE || 'http://127.0.0.1:8088').replace(/\/+$/, ''),
  relayUrl: (process.env.RELAY_URL || 'http://127.0.0.1:8797').replace(/\/+$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  domain: (process.env.MAIL_DOMAIN || 'yourdomain.com').toLowerCase(),
  maxDays: Number(process.env.MAX_SCHED_DAYS || 60),
  dir: '/var/lib/bv-schedule',
  maxBytes: 25 * 1024 * 1024,
  maxAttempts: 6,
};
const PEND = `${CFG.dir}/pending`, SENT = `${CFG.dir}/sent`, FAIL = `${CFG.dir}/failed`;
const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmails = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length <= 320 && EMAIL.test(x));

// Validate the client's Bearer by delegating to the API. Returns the owner key
// (the token's authenticated id-segment) or null.
async function authOwner(req) {
  const auth = req.headers['authorization'] || '';
  if (!/^Bearer\s+\S/.test(auth)) return null;
  let r;
  try { r = await fetch(`${CFG.apiBase}/api/users/me`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) }); }
  catch { return null; }
  if (r.status !== 200) return null;
  const token = auth.replace(/^Bearer\s+/, '').trim();
  const owner = token.split('.')[0]; // id segment, verified valid by the API above
  return owner && owner.length >= 8 && owner.length <= 200 ? owner : null;
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > CFG.maxBytes) throw new Error('too_large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function listOwner(owner) {
  const out = [];
  for (const f of await readdir(PEND).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(`${PEND}/${f}`, 'utf8'));
      if (rec.owner === owner) out.push({ id: rec.id, send_at: rec.send_at, to: rec.payload.to, cc: rec.payload.cc || [], subject: rec.payload.subject, created_at: rec.created_at });
    } catch {}
  }
  return out.sort((a, b) => new Date(a.send_at) - new Date(b.send_at));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/api/schedule') {
      const owner = await authOwner(req); if (!owner) return J(res, 401, { error: 'unauthorized' });
      let b; try { b = await readBody(req); } catch (e) { return J(res, e.message === 'too_large' ? 413 : 400, { error: e.message }); }
      const local = String(b.from_local || '').toLowerCase();
      if (!/^[a-z0-9._-]{1,64}$/.test(local)) return J(res, 400, { error: 'bad_from_local' });
      const to = b.to || [], cc = b.cc || [], bcc = b.bcc || [];
      if (!isEmails(to) || !isEmails(cc) || !isEmails(bcc)) return J(res, 400, { error: 'bad_recipient' });
      if (to.length + cc.length + bcc.length === 0) return J(res, 400, { error: 'no_recipients' });
      if (to.length + cc.length + bcc.length > 15) return J(res, 400, { error: 'too_many_recipients' });
      const when = new Date(b.send_at);
      if (isNaN(+when)) return J(res, 400, { error: 'bad_send_at' });
      if (+when < Date.now() + 30_000) return J(res, 400, { error: 'send_at_in_past' });
      if (+when > Date.now() + CFG.maxDays * 864e5) return J(res, 400, { error: 'send_at_too_far' });
      const id = randomBytes(16).toString('hex');
      const rec = {
        id, owner, send_at: when.toISOString(), created_at: new Date().toISOString(), attempts: 0,
        payload: {
          from_local: local, to, cc, bcc,
          subject: String(b.subject || '').slice(0, 998),
          text: typeof b.text === 'string' ? b.text : '',
          ...(typeof b.html === 'string' && b.html ? { html: b.html } : {}),
          ...(Array.isArray(b.attachments) ? { attachments: b.attachments.slice(0, 25).map((a) => ({ filename: String(a.filename || 'attachment'), mime: String(a.mime || 'application/octet-stream'), data_b64: String(a.data_b64 || '') })) } : {}),
        },
      };
      await writeFile(`${PEND}/${id}.json`, JSON.stringify(rec), { mode: 0o600 });
      return J(res, 200, { id, send_at: rec.send_at });
    }
    if (req.method === 'GET' && url === '/api/scheduled') {
      const owner = await authOwner(req); if (!owner) return J(res, 401, { error: 'unauthorized' });
      return J(res, 200, { scheduled: await listOwner(owner) });
    }
    if (req.method === 'POST' && url === '/api/scheduled/cancel') {
      const owner = await authOwner(req); if (!owner) return J(res, 401, { error: 'unauthorized' });
      let b; try { b = await readBody(req); } catch { return J(res, 400, { error: 'bad_body' }); }
      const id = String(b.id || '');
      if (!/^[0-9a-f]{32}$/.test(id)) return J(res, 400, { error: 'bad_id' });
      try {
        const rec = JSON.parse(await readFile(`${PEND}/${id}.json`, 'utf8'));
        if (rec.owner !== owner) return J(res, 404, { error: 'not_found' });
        await unlink(`${PEND}/${id}.json`);
        return J(res, 200, { canceled: id });
      } catch { return J(res, 404, { error: 'not_found' }); }
    }
    J(res, 404, { error: 'not_found' });
  } catch (e) { J(res, 500, { error: 'internal' }); console.error('req error', e.message); }
});

// --- worker: dispatch due sends via the relay ---------------------------
function buildMime(p) {
  return new Promise((resolve, reject) => {
    const mc = new MailComposer({
      from: `${p.from_local}@${CFG.domain}`,
      to: p.to, ...(p.cc && p.cc.length ? { cc: p.cc } : {}), // bcc intentionally omitted from headers
      subject: p.subject || '',
      text: p.text || '',
      ...(p.html ? { html: p.html } : {}),
      ...(p.attachments && p.attachments.length ? { attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.mime, content: Buffer.from(a.data_b64, 'base64') })) } : {}),
    });
    mc.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}
async function dispatch(rec) {
  const p = rec.payload;
  const mime = await buildMime(p);
  const rcpts = [...p.to, ...(p.cc || []), ...(p.bcc || [])];
  const r = await fetch(`${CFG.relayUrl}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.relayToken}` },
    body: JSON.stringify({ outbox_id: `sched-${rec.id}`, mime_b64: mime.toString('base64'), rcpts }),
    signal: AbortSignal.timeout(45000),
  });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`relay ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
}
let sweeping = false;
async function sweep() {
  if (sweeping) return; sweeping = true;
  try {
    const now = Date.now();
    for (const f of await readdir(PEND).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      const path = `${PEND}/${f}`;
      let rec; try { rec = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      if (+new Date(rec.send_at) > now) continue;
      try {
        await dispatch(rec);
        rec.sent_at = new Date().toISOString();
        await writeFile(path, JSON.stringify(rec)); await rename(path, `${SENT}/${f}`);
        console.error(`sent ${rec.id} -> ${rec.payload.to.join(',')}`);
      } catch (e) {
        rec.attempts = (rec.attempts || 0) + 1; rec.last_error = String(e.message).slice(0, 300);
        await writeFile(path, JSON.stringify(rec));
        if (rec.attempts >= CFG.maxAttempts) { await rename(path, `${FAIL}/${f}`); console.error(`FAILED ${rec.id}: ${rec.last_error}`); }
        else console.error(`retry ${rec.id} (attempt ${rec.attempts}): ${rec.last_error}`);
      }
    }
  } finally { sweeping = false; }
}

server.listen(CFG.port, '127.0.0.1', () => {
  console.error(`bv-schedule listening on 127.0.0.1:${CFG.port}; relay=${CFG.relayUrl}; api=${CFG.apiBase}`);
  setInterval(sweep, 20_000);
  setTimeout(sweep, 3000);
});

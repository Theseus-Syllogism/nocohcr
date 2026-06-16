#!/usr/bin/env node
// bv-board — Community Board backend for the BlindVault / Blindvault PWA.
//
// Powers the #/board* UI (classified-style local board: resource updates,
// warnings, help wanted/offered, events, free stuff, rides, lost & found...).
// ANONYMOUS by design — no vault login. A poster gets a one-time `view_secret`
// on create (the "private link key"); it is the ONLY credential for managing
// the post (edit / renew / delete) and for reading the private replies. We
// store only sha256(secret), never the secret itself.
//
// Zero external deps (pure node:*). Single-process, low-volume; state is a JSON
// file persisted with atomic write-and-rename, plus image blobs on disk.
//
// Routes (fronted same-origin by nginx at /api/board/*; nginx adds no-store):
//   GET    /api/board/health                      -> {ok:true}
//   GET    /api/board/categories                  -> {categories:[{slug,label}]}
//   GET    /api/board/posts[?category&sort&bbox]  -> {posts:[<list item>]}
//   POST   /api/board/posts        {category,title,body,enable_replies,
//                                   lat?,lon?,event_start?,event_end?,
//                                   venue?,images?:[hash]}  -> {id,view_secret}
//   GET    /api/board/posts/:id                   -> <detail post> | 404
//   PATCH  /api/board/posts/:id    {title,body,venue,enable_replies}   [secret]
//   DELETE /api/board/posts/:id                                        [secret]
//   POST   /api/board/posts/:id/renew                                  [secret]
//   POST   /api/board/posts/:id/flag                                   (public)
//   GET    /api/board/posts/:id/replies                -> {replies:[…]} [secret]
//   POST   /api/board/posts/:id/replies  {body,contact?}               (public)
//   POST   /api/board/images   (raw bytes, content-type=img mime)  -> {hash}
//   GET    /api/board/images/:hash                 -> image bytes
// [secret] = requires the x-board-secret header to match the post's view_secret.

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const CFG = {
  port: Number(process.env.BOARD_PORT || 8802),
  dir: process.env.BOARD_DIR || '/var/lib/bv-board',
  ttlDays: Number(process.env.BOARD_TTL_DAYS || 30),       // initial post lifetime
  renewDays: Number(process.env.BOARD_RENEW_DAYS || 7),    // "Renew (+7 days)"
  maxImageBytes: Number(process.env.BOARD_MAX_IMAGE_BYTES || 8 * 1024 * 1024),
  maxBodyBytes: Number(process.env.BOARD_MAX_BODY_BYTES || 64 * 1024),
  flagsToHide: Number(process.env.BOARD_FLAGS_TO_HIDE || 3),
};
const IMG_DIR = `${CFG.dir}/images`;
const DB_PATH = `${CFG.dir}/board.json`;

// Categories — mirrors the frontend fallback list (Q5) exactly. The UI maps a
// post's category slug to a label; an unknown slug would render blank, so the
// create path validates against these.
const CATS = [
  { slug: 'resource_update', label: 'Resource update' },
  { slug: 'warning', label: 'Warning' },
  { slug: 'help_needed', label: 'Help needed' },
  { slug: 'help_offered', label: 'Help offered' },
  { slug: 'event', label: 'Events' },
  { slug: 'group', label: 'Groups & Meetups' },
  { slug: 'volunteer', label: 'Volunteer' },
  { slug: 'give_away', label: 'Free / Give away' },
  { slug: 'ride', label: 'Rides' },
  { slug: 'sublet', label: 'Sublet / Couch' },
  { slug: 'lost_found', label: 'Lost & Found' },
  { slug: 'general', label: 'General' },
];
const CAT_SLUGS = new Set(CATS.map((c) => c.slug));
const ALLOWED_IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

// --- helpers ---------------------------------------------------------------
const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const nowISO = () => new Date().toISOString();
const newId = () => randomBytes(9).toString('base64url');       // ~12 chars, URL-safe
const newSecret = () => randomBytes(18).toString('base64url');  // ~24 chars

function secretMatches(provided, hash) {
  if (typeof provided !== 'string' || !provided || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(sha256(provided), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function coordOrNull(v, lim) { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= lim ? n : null; }
function isoOrNull(v) {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function clientIp(req) {
  const xr = req.headers['x-real-ip'];
  if (typeof xr === 'string' && xr.trim()) return xr.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

async function readBody(req, cap = CFG.maxBodyBytes) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > cap) throw new Error('too_large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, cap = CFG.maxBodyBytes) {
  const buf = await readBody(req, cap);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

// --- in-memory rate limiting (sliding window per IP+action) ----------------
// nginx already caps /api/ at 40r/s; this adds per-action abuse ceilings the
// UI explicitly handles with a 429 ("posting too fast", etc).
const buckets = new Map(); // key -> number[] (timestamps ms)
function rateLimited(ip, action, max, windowMs) {
  const key = `${action}:${ip}`;
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr);
  return false;
}
setInterval(() => { // prune idle buckets hourly
  const now = Date.now();
  for (const [k, arr] of buckets) { const live = arr.filter((t) => now - t < 3600_000); if (live.length) buckets.set(k, live); else buckets.delete(k); }
}, 3600_000).unref();

// --- persistence -----------------------------------------------------------
// db = { posts: { id: post }, images: { hash: {type,bytes,created_at} } }
let db = { posts: {}, images: {} };
let writing = false, dirtyAgain = false;
async function persist() {
  if (writing) { dirtyAgain = true; return; }
  writing = true;
  try {
    do {
      dirtyAgain = false;
      const tmp = `${DB_PATH}.tmp`;
      await writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
      await rename(tmp, DB_PATH);
    } while (dirtyAgain);
  } finally { writing = false; }
}
async function loadDb() {
  try { db = JSON.parse(await readFile(DB_PATH, 'utf8')); }
  catch { db = { posts: {}, images: {} }; }
  if (!db.posts) db.posts = {};
  if (!db.images) db.images = {};
}

// --- post state helpers ----------------------------------------------------
const isExpired = (p) => Date.parse(p.expires_at) <= Date.now();
const isHidden = (p) => (p.flaggers?.length || 0) >= CFG.flagsToHide;
const isVisible = (p) => !isHidden(p) && !isExpired(p);

function listItem(p) {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    images: (p.images || []).map((hash) => ({ hash })),
    event_start: p.event_start || null,
    created_at: p.created_at,
    venue: p.venue || null,
    lat: p.lat ?? null,
    lon: p.lon ?? null,
  };
}
function detailItem(p) {
  return {
    id: p.id,
    title: p.title,
    body: p.body,
    category: p.category,
    created_at: p.created_at,
    expires_at: p.expires_at,
    lat: p.lat ?? null,
    lon: p.lon ?? null,
    event_start: p.event_start || null,
    event_end: p.event_end || null,
    venue: p.venue || null,
    images: (p.images || []).map((hash) => ({ hash })),
    has_replies_mailbox: !!p.enable_replies,
  };
}

// --- route handlers --------------------------------------------------------
function listPosts(query) {
  const category = query.get('category');
  const sortEvent = query.get('sort') === 'event_start';
  let bbox = null;
  const raw = query.get('bbox');
  if (raw) {
    const n = raw.split(',').map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) bbox = { minLon: n[0], minLat: n[1], maxLon: n[2], maxLat: n[3] };
  }
  let posts = Object.values(db.posts).filter(isVisible);
  if (category && CAT_SLUGS.has(category)) posts = posts.filter((p) => p.category === category);
  if (bbox) {
    // Keep coordless posts visible; geo-filter only those that have coords.
    posts = posts.filter((p) => p.lat == null || p.lon == null ||
      (p.lon >= bbox.minLon && p.lon <= bbox.maxLon && p.lat >= bbox.minLat && p.lat <= bbox.maxLat));
  }
  posts.sort((a, b) => {
    if (sortEvent) {
      const ea = a.event_start ? Date.parse(a.event_start) : Infinity;
      const eb = b.event_start ? Date.parse(b.event_start) : Infinity;
      if (ea !== eb) return ea - eb;
    }
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
  return { posts: posts.map(listItem) };
}

async function createPost(req, ip) {
  if (rateLimited(ip, 'post', 10, 3600_000)) return { code: 429, body: { error: 'rate_limited' } };
  const b = await readJson(req);
  const category = typeof b.category === 'string' && CAT_SLUGS.has(b.category) ? b.category : null;
  if (!category) return { code: 400, body: { error: 'bad_category' } };
  const title = clampStr(b.title, 120);
  const body = clampStr(b.body, 2000);
  if (!title || !body) return { code: 400, body: { error: 'title_and_body_required' } };

  let images = [];
  if (Array.isArray(b.images)) {
    images = b.images.filter((h) => typeof h === 'string' && db.images[h]).slice(0, 3);
  }
  const secret = newSecret();
  let id; do { id = newId(); } while (db.posts[id]);
  const created = nowISO();
  const post = {
    id,
    category,
    title,
    body,
    enable_replies: !!b.enable_replies,
    lat: coordOrNull(b.lat, 90),
    lon: coordOrNull(b.lon, 180),
    event_start: category === 'event' ? isoOrNull(b.event_start) : null,
    event_end: category === 'event' ? isoOrNull(b.event_end) : null,
    venue: clampStr(b.venue, 200) || null,
    images,
    created_at: created,
    expires_at: new Date(Date.now() + CFG.ttlDays * 86400_000).toISOString(),
    secret_hash: sha256(secret),
    flaggers: [],
    replies: [],
  };
  db.posts[id] = post;
  await persist();
  return { code: 201, body: { id, view_secret: secret } };
}

async function patchPost(req, p, secret) {
  if (!secretMatches(secret, p.secret_hash)) return { code: 403, body: { error: 'forbidden' } };
  const b = await readJson(req);
  const title = clampStr(b.title, 120);
  const body = clampStr(b.body, 2000);
  if (!title || !body) return { code: 400, body: { error: 'title_and_body_required' } };
  p.title = title;
  p.body = body;
  p.venue = clampStr(b.venue, 200) || null;
  if ('enable_replies' in b) p.enable_replies = !!b.enable_replies;
  await persist();
  return { code: 200, body: { ok: true } };
}

async function renewPost(p, secret) {
  if (!secretMatches(secret, p.secret_hash)) return { code: 403, body: { error: 'forbidden' } };
  const base = Math.max(Date.now(), Date.parse(p.expires_at) || 0);
  p.expires_at = new Date(base + CFG.renewDays * 86400_000).toISOString();
  await persist();
  return { code: 200, body: { ok: true, expires_at: p.expires_at } };
}

async function deletePost(p, secret) {
  if (!secretMatches(secret, p.secret_hash)) return { code: 403, body: { error: 'forbidden' } };
  delete db.posts[p.id];
  await persist();
  return { code: 200, body: { ok: true } };
}

async function flagPost(p, ip) {
  if (rateLimited(ip, 'flag', 30, 3600_000)) return { code: 429, body: { error: 'rate_limited' } };
  const fp = sha256(ip).slice(0, 16);
  if (!p.flaggers) p.flaggers = [];
  if (!p.flaggers.includes(fp)) { p.flaggers.push(fp); await persist(); }
  return { code: 200, body: { ok: true } };
}

function getReplies(p, secret) {
  if (!secretMatches(secret, p.secret_hash)) return { code: 403, body: { error: 'forbidden' } };
  const replies = (p.replies || []).map((r) => ({ body: r.body, contact: r.contact || null, created_at: r.created_at }));
  return { code: 200, body: { replies } };
}

async function addReply(req, p, ip) {
  if (!p.enable_replies) return { code: 403, body: { error: 'replies_disabled' } };
  if (rateLimited(ip, 'reply', 20, 3600_000)) return { code: 429, body: { error: 'rate_limited' } };
  const b = await readJson(req);
  const body = clampStr(b.body, 1000);
  if (!body) return { code: 400, body: { error: 'empty_reply' } };
  const reply = { body, contact: clampStr(b.contact, 200) || null, created_at: nowISO() };
  if (!p.replies) p.replies = [];
  p.replies.push(reply);
  await persist();
  return { code: 201, body: { ok: true } };
}

async function uploadImage(req, ip) {
  if (rateLimited(ip, 'image', 30, 3600_000)) return { code: 429, body: { error: 'rate_limited' } };
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMG.has(type)) return { code: 415, body: { error: 'unsupported_type' } };
  let buf;
  try { buf = await readBody(req, CFG.maxImageBytes); }
  catch (e) { return e.message === 'too_large' ? { code: 413, body: { error: 'too_large' } } : { code: 400, body: { error: 'bad_body' } }; }
  if (!buf.length) return { code: 400, body: { error: 'empty' } };
  const hash = sha256(buf);
  if (!db.images[hash]) {
    await writeFile(path.join(IMG_DIR, hash), buf, { mode: 0o644 });
    db.images[hash] = { type, bytes: buf.length, created_at: nowISO() };
    await persist();
  }
  return { code: 200, body: { hash } };
}

async function serveImage(res, hash) {
  const meta = db.images[hash];
  if (!meta || !/^[a-f0-9]{64}$/.test(hash)) return J(res, 404, { error: 'not_found' });
  let buf;
  try { buf = await readFile(path.join(IMG_DIR, hash)); }
  catch { return J(res, 404, { error: 'not_found' }); }
  res.writeHead(200, {
    'content-type': meta.type || 'application/octet-stream',
    'content-length': buf.length,
    // content-addressed => safe to cache hard (nginx may override to no-store).
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(buf);
}

// --- HTTP ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const url = u.pathname;
    const m = req.method;
    const ip = clientIp(req);
    const secret = req.headers['x-board-secret'];

    if (!url.startsWith('/api/board/')) return J(res, 404, { error: 'not_found' });
    if (m === 'GET' && url === '/api/board/health') return J(res, 200, { ok: true });
    if (m === 'GET' && url === '/api/board/categories') return J(res, 200, { categories: CATS });

    // Images
    if (url === '/api/board/images' && m === 'POST') { const r = await uploadImage(req, ip); return J(res, r.code, r.body); }
    if (url.startsWith('/api/board/images/') && m === 'GET') {
      return serveImage(res, decodeURIComponent(url.slice('/api/board/images/'.length)));
    }

    // Posts collection
    if (url === '/api/board/posts') {
      if (m === 'GET') return J(res, 200, listPosts(u.searchParams));
      if (m === 'POST') { const r = await createPost(req, ip); return J(res, r.code, r.body); }
      return J(res, 405, { error: 'method_not_allowed' });
    }

    // Per-post: /api/board/posts/:id[/sub]
    if (url.startsWith('/api/board/posts/')) {
      const rest = url.slice('/api/board/posts/'.length).split('/');
      const id = decodeURIComponent(rest[0] || '');
      const sub = rest[1] || '';
      const p = db.posts[id];

      if (!sub) {
        if (m === 'GET') { if (!p || !isVisible(p)) return J(res, 404, { error: 'not_found' }); return J(res, 200, detailItem(p)); }
        if (!p) return J(res, 404, { error: 'not_found' });
        if (m === 'PATCH') { const r = await patchPost(req, p, secret); return J(res, r.code, r.body); }
        if (m === 'DELETE') { const r = await deletePost(p, secret); return J(res, r.code, r.body); }
        return J(res, 405, { error: 'method_not_allowed' });
      }
      if (!p) return J(res, 404, { error: 'not_found' });
      if (sub === 'flag' && m === 'POST') { const r = await flagPost(p, ip); return J(res, r.code, r.body); }
      if (sub === 'renew' && m === 'POST') { const r = await renewPost(p, secret); return J(res, r.code, r.body); }
      if (sub === 'replies') {
        if (m === 'GET') { const r = getReplies(p, secret); return J(res, r.code, r.body); }
        if (m === 'POST') { const r = await addReply(req, p, ip); return J(res, r.code, r.body); }
      }
      return J(res, 404, { error: 'not_found' });
    }

    return J(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e.message === 'too_large') return J(res, 413, { error: 'too_large' });
    if (e instanceof SyntaxError) return J(res, 400, { error: 'bad_json' });
    console.error('req error', e.message);
    return J(res, 500, { error: 'internal' });
  }
});

await mkdir(CFG.dir, { recursive: true });
await mkdir(IMG_DIR, { recursive: true });
await loadDb();
server.listen(CFG.port, '127.0.0.1', () => console.log(`bv-board on 127.0.0.1:${CFG.port} dir=${CFG.dir}`));

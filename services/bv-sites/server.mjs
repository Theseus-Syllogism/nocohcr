#!/usr/bin/env node
// bv-sites — Neocities-style static personal sites at <handle>.yourdomain.com.
//
// Signed-in users claim a handle, edit/upload files, and publish. Content is
// HTML/CSS/assets only: JavaScript is REJECTED on upload and STRIPPED from HTML
// on publish (DOMPurify via jsdom). The serving vhost additionally sends
// `script-src 'none'`, so nothing executes even if a sink is ever missed
// (defense in depth — sanitizer is hygiene, CSP is the enforcement boundary).
//
// Auth: same pattern as bv-schedule — delegate the client's Bearer token to the
// API's /api/users/me (200 => valid); the owner key is the token's id-segment.
//
// Storage (per handle, under SITES_DIR; modes chosen so nginx can serve
// published/ but cannot read meta.json):
//   <handle>/             0755  (nginx traverses this to reach published/)
//   <handle>/staging/     0755  working tree (editor/uploads write here; NOT served)
//   <handle>/published/   0755  atomically swapped copy nginx serves (files 0644)
//   <handle>/meta.json    0600  {owner,handle,created_at,published_at,snapshots?}
//   .owners/<sha256(owner)> 0600  one handle per owner (claim guard)
//
// Routes (fronted same-origin by nginx at /api/sites/*):
//   GET    /api/sites/health             -> {ok:true}            (no auth)
//   GET    /api/sites/me                 -> {handle,published_at,usage,url,limits} | {handle:null}
//   POST   /api/sites/claim   {handle}   -> {handle}
//   GET    /api/sites/tree               -> {handle,files:[{path,bytes}],usage}
//   PUT    /api/sites/file    {path, text? | data_b64?}
//   DELETE /api/sites/file    {path}
//   POST   /api/sites/upload  {files:[{path,data_b64}]} | {zip_b64}
//   POST   /api/sites/publish            -> {published_at, url, sanitized:[...]}
//   POST   /api/sites/unpublish          -> takes the site offline (removes published/)

import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm, rename, stat, cp, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { unzipSync, zipSync } from 'fflate';

const CFG = {
  port: Number(process.env.SITES_PORT || 8800),
  apiBase: (process.env.API_BASE || 'http://127.0.0.1:8088').replace(/\/+$/, ''),
  baseDomain: (process.env.BASE_DOMAIN || 'yourdomain.com').toLowerCase(),
  dir: process.env.SITES_DIR || '/var/lib/bv-sites',
  maxSiteBytes: Number(process.env.MAX_SITE_BYTES || 50 * 1024 * 1024),
  maxFiles: Number(process.env.MAX_FILES || 200),
  maxFileBytes: Number(process.env.MAX_FILE_BYTES || 10 * 1024 * 1024),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 60 * 1024 * 1024),
  blobUrl: (process.env.BLOBSTORE_URL || '').replace(/\/+$/, ''),
  blobToken: process.env.BLOBSTORE_TOKEN || '',
  templatesDir: process.env.TEMPLATES_DIR || '/opt/bv-sites/templates',
  relayUrl: (process.env.RELAY_URL || 'http://127.0.0.1:8797').replace(/\/+$/, ''),
  relayToken: process.env.RELAY_TOKEN || '',
  mailDomain: (process.env.MAIL_DOMAIN || 'yourdomain.com').toLowerCase(),
  formDailyMax: Number(process.env.SITE_FORM_DAILY_MAX || 50),
  shotsUrl: (process.env.SHOTS_URL || 'http://127.0.0.1:8803').replace(/\/+$/, ''),
  shotsToken: process.env.SHOTS_TOKEN || '',
  shotsDir: process.env.SHOTS_DIR || '/var/lib/bv-shots/thumbs',
};
const OWNERS = `${CFG.dir}/.owners`;

// --- DOMPurify (server-side via jsdom) -------------------------------------
const DOMPurify = createDOMPurify(new JSDOM('').window);

// --- reserved handles: live/operational subdomains + footguns --------------
const RESERVED = new Set([
  'www','www2','mail','smtp','imap','pop','pop3','mx','ns','ns1','ns2','dns',
  'meet','mta-sts','autoconfig','autodiscover','_dmarc','dmarc','dkim','spf',
  'api','app','admin','administrator','root','sysadmin','webmaster','postmaster',
  'hostmaster','abuse','security','noc','status','help','support','about','contact',
  'cdn','static','assets','img','images','media','files','download','downloads',
  'blog','news','dev','test','testing','stage','staging','prod','beta','demo',
  'login','signin','signup','register','account','accounts','auth','oauth','sso',
  'vault','blindvault','yourapp','yourtown','hcr',
  'me','my','user','users','site','sites','page','pages','home','public',
]);
const BADWORDS = ['fuck','shit','cunt','nigg','faggot','rape','nazi','kike','spic','retard','childporn'];

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/; // 3..32 chars, no edge hyphen
function handleValid(h) {
  if (typeof h !== 'string') return false;
  h = h.toLowerCase();
  if (!HANDLE_RE.test(h)) return false;
  if (h.startsWith('xn--')) return false;   // no punycode / IDN homographs
  if (h.includes('--')) return false;       // avoid xn-- lookalikes / confusables
  if (RESERVED.has(h)) return false;
  if (BADWORDS.some((w) => h.includes(w))) return false;
  return true;
}

// --- helpers ---------------------------------------------------------------
const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function authOwner(req) {
  const auth = req.headers['authorization'] || '';
  if (!/^Bearer\s+\S/.test(auth)) return null;
  let r;
  try { r = await fetch(`${CFG.apiBase}/api/users/me`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) }); }
  catch { return null; }
  if (r.status !== 200) return null;
  const token = auth.replace(/^Bearer\s+/, '').trim();
  const owner = token.split('.')[0]; // id segment, verified valid by the API above
  // identityIdB64 is STANDARD base64 (btoa, padding stripped), so it can contain
  // '+' and '/' — must be allowed here or ~74% of users 401 ("session expired").
  // owner is only ever consumed as a sha256 hash input / JSON value, never a path.
  return owner && owner.length >= 8 && owner.length <= 200 && /^[A-Za-z0-9+/._~-]+$/.test(owner) ? owner : null;
}

async function readBody(req, cap = CFG.maxBodyBytes) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > cap) throw new Error('too_large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// Safe relative path within a site: no traversal, no dotfiles, sane chars.
function safeRel(p) {
  if (typeof p !== 'string' || !p) return null;
  const s = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (s.length > 512) return null;
  const norm = path.posix.normalize(s);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../') || norm.startsWith('/')) return null;
  const parts = norm.split('/');
  if (parts.length > 12) return null;
  for (const seg of parts) {
    if (!seg || seg === '.') return null;
    if (seg.startsWith('.')) return null;                 // no dotfiles/dirs
    if (!/^[A-Za-z0-9._ -]{1,96}$/.test(seg)) return null;
  }
  return parts.join('/');
}

const EXT_DENY = new Set(['js','mjs','cjs','jsx','ts','tsx','wasm','php','phtml','phar','php3','php4','php5','cgi','pl','py','rb','sh','bash','htaccess','asp','aspx','jsp','map']);
const EXT_HTML = new Set(['html','htm','xhtml','shtml','shtm']); // shtml is mime-typed text/html by nginx — must go through sanitizeHtml, not raw cp()
const TEXT_EXT = new Set(['html','htm','xhtml','shtml','shtm','css','svg','txt','md','markdown','json','xml','csv','webmanifest']);
const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };

const ownerHandlePath = (owner) => `${OWNERS}/${createHash('sha256').update(owner).digest('hex')}`;
const getOwnerHandle = async (owner) => { try { return (await readFile(ownerHandlePath(owner), 'utf8')).trim() || null; } catch { return null; } };
const loadMeta = async (handle) => { try { return JSON.parse(await readFile(`${CFG.dir}/${handle}/meta.json`, 'utf8')); } catch { return null; } };

async function walk(root) {
  const out = [];
  const rec = async (rel) => {
    let ents; try { ents = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(r);
      else if (e.isFile()) { const st = await stat(path.join(root, r)); out.push({ path: r, bytes: st.size }); }
    }
  };
  await rec('');
  return out;
}
const usage = async (handle) => {
  const files = await walk(`${CFG.dir}/${handle}/staging`);
  return { files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) };
};

async function chmodTree(root, dirMode, fileMode) {
  const rec = async (p) => {
    const st = await stat(p);
    if (st.isDirectory()) { await chmod(p, dirMode); for (const e of await readdir(p)) await rec(path.join(p, e)); }
    else await chmod(p, fileMode);
  };
  await rec(root);
}

// --- sanitizers (the JS-strip the user asked for) --------------------------
const sanitizeHtml = (src) => '<!DOCTYPE html>\n' + DOMPurify.sanitize(src, {
  WHOLE_DOCUMENT: true,
  ADD_TAGS: ['link', 'style', 'meta'],
  ADD_ATTR: ['rel', 'href', 'type', 'media', 'charset', 'name', 'content', 'target', 'property'], // 'property' => og:* meta survive
  FORBID_TAGS: ['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'base', 'form'],
  FORBID_ATTR: ['http-equiv', 'ping', 'formaction', 'srcdoc'],
  ALLOW_DATA_ATTR: true,
});
const sanitizeSvg = (src) => DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true } });

// --- server-enforced hardening --------------------------------------------
// publish() is the REAL trust boundary, not the client builder: an attacker can
// PUT raw HTML/CSS/SVG and publish. These global DOMPurify hooks (+ scrubCss,
// applied to .css files in publish) close: F1 meta-refresh redirects, F2/F3 CSS
// phishing/exfiltration, F4 unsafe <a>, F5 abusable <link> rels, F11 external
// SVG refs. The no-JS guarantee itself rests on script-src 'self' + EXT_DENY +
// nosniff (serve layer), NOT on these hooks.
const isExternalUrl = (v) => {
  const s = String(v || '').trim();
  if (s.startsWith('//')) return true;                                   // protocol-relative
  if (/^https?:/i.test(s)) return true;                                  // absolute http(s)
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s) && !/^(?:mailto:|tel:)/i.test(s)) return true; // other schemes (data:, etc.)
  return false;                                                          // relative, #, /path, mailto, tel
};
function scrubCss(css) {
  return String(css || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                                   // strip CSS comments first (else position:/**/fixed slips the regex below)
    .replace(/@import[^;]*;?/gi, '')                                     // no @import (exfil/abuse)
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\1\s*\)/gi, 'url()') // no external url() (exfil/tracking)
    .replace(/expression\s*\(/gi, '_expr(')                             // legacy IE expression()
    .replace(/position\s*:\s*fixed\b/gi, 'position:static')             // no full-viewport phishing overlays
    .replace(/position\s*:\s*sticky\b/gi, 'position:relative');
}
const SVG_NS = 'http://www.w3.org/2000/svg';
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  const tag = (data && data.tagName) || '';
  if (tag === 'meta' && node.getAttribute) {
    if (((node.getAttribute('name') || '').toLowerCase().trim()) === 'refresh') node.parentNode && node.parentNode.removeChild(node); // F1
  } else if (tag === 'link' && node.getAttribute) {                      // F5
    const rel = (node.getAttribute('rel') || '').toLowerCase().trim();
    const href = node.getAttribute('href') || '';
    const okRel = ['icon', 'shortcut icon', 'apple-touch-icon', 'mask-icon', 'stylesheet', 'manifest'].includes(rel);
    if (!okRel || ((rel === 'stylesheet' || rel === 'manifest') && isExternalUrl(href))) node.parentNode && node.parentNode.removeChild(node);
  }
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!node || !node.getAttribute) return;
  const tag = (node.tagName || '').toLowerCase();
  if (tag === 'a') {                                                     // F4
    if ((node.getAttribute('target') || '') === '_blank') node.setAttribute('rel', 'noopener noreferrer');
    if (/^\s*\/\//.test(node.getAttribute('href') || '')) node.removeAttribute('href');
  }
  if (node.hasAttribute && node.hasAttribute('style')) node.setAttribute('style', scrubCss(node.getAttribute('style'))); // F2/F3
  if (tag === 'style') node.textContent = scrubCss(node.textContent || '');                                              // F2/F3
  if (node.namespaceURI === SVG_NS) {                                    // F11
    for (const a of ['href', 'xlink:href']) { const v = node.getAttribute(a); if (v && isExternalUrl(v)) node.removeAttribute(a); }
  }
});

// --- operations ------------------------------------------------------------
async function claim(owner, handleRaw) {
  const handle = String(handleRaw || '').toLowerCase();
  if (!handleValid(handle)) return { code: 400, body: { error: 'invalid_handle' } };
  const existing = await getOwnerHandle(owner);
  if (existing) return { code: 409, body: { error: 'already_have_site', handle: existing } };
  if (await loadMeta(handle)) return { code: 409, body: { error: 'handle_taken' } };
  const base = `${CFG.dir}/${handle}`;
  try { await mkdir(base, { recursive: false, mode: 0o755 }); }       // exclusive create = race guard
  catch { return { code: 409, body: { error: 'handle_taken' } }; }
  await chmod(base, 0o755);
  await mkdir(`${base}/staging`, { recursive: true, mode: 0o755 });
  const meta = { owner, handle, created_at: new Date().toISOString(), published_at: null };
  await writeFile(`${base}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  await writeFile(ownerHandlePath(owner), handle, { mode: 0o600 });
  const starter = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${handle}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#222}a{color:#2563eb}</style></head>
<body><h1>${handle}</h1><p>Your new site is live. Edit <code>index.html</code> to make it yours.</p></body></html>
`;
  await writeFile(`${base}/staging/index.html`, starter, { mode: 0o644 });
  try { await publish(handle); } catch {}   // make the subdomain live immediately
  return { code: 200, body: { handle, url: `https://${handle}.${CFG.baseDomain}/` } };
}

async function putFile(handle, body) {
  const rel = safeRel(body.path);
  if (!rel) return { code: 400, body: { error: 'bad_path' } };
  if (EXT_DENY.has(extOf(rel))) return { code: 400, body: { error: 'ext_not_allowed', detail: extOf(rel) } };
  let buf;
  if (typeof body.text === 'string') buf = Buffer.from(body.text, 'utf8');
  else if (typeof body.data_b64 === 'string') { try { buf = Buffer.from(body.data_b64, 'base64'); } catch { return { code: 400, body: { error: 'bad_b64' } }; } }
  else return { code: 400, body: { error: 'no_content' } };
  if (buf.length > CFG.maxFileBytes) return { code: 413, body: { error: 'file_too_large', max: CFG.maxFileBytes } };
  const stageRoot = `${CFG.dir}/${handle}/staging`;
  const dst = path.join(stageRoot, rel);
  let prev = 0; try { prev = (await stat(dst)).size; } catch {}
  const u = await usage(handle);
  if (u.files + (prev ? 0 : 1) > CFG.maxFiles) return { code: 413, body: { error: 'too_many_files', max: CFG.maxFiles } };
  if (u.bytes - prev + buf.length > CFG.maxSiteBytes) return { code: 413, body: { error: 'quota_exceeded', max: CFG.maxSiteBytes } };
  await mkdir(path.dirname(dst), { recursive: true, mode: 0o755 });
  await writeFile(dst, buf, { mode: 0o644 });
  return { code: 200, body: { path: rel, bytes: buf.length } };
}

async function delFile(handle, body) {
  const rel = safeRel(body.path);
  if (!rel) return { code: 400, body: { error: 'bad_path' } };
  try { await rm(path.join(`${CFG.dir}/${handle}/staging`, rel)); return { code: 200, body: { deleted: rel } }; }
  catch { return { code: 404, body: { error: 'not_found' } }; }
}

async function upload(handle, body) {
  const stageRoot = `${CFG.dir}/${handle}/staging`;
  const incoming = [];
  if (typeof body.zip_b64 === 'string') {
    let zipBuf; try { zipBuf = Buffer.from(body.zip_b64, 'base64'); } catch { return { code: 400, body: { error: 'bad_b64' } }; }
    let entries; try { entries = unzipSync(new Uint8Array(zipBuf)); } catch { return { code: 400, body: { error: 'bad_zip' } }; }
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      const rel = safeRel(name);
      if (!rel) return { code: 400, body: { error: 'bad_path_in_zip', detail: name } };
      if (EXT_DENY.has(extOf(rel))) continue;          // silently skip scripts
      incoming.push({ rel, buf: Buffer.from(data) });
    }
  } else if (Array.isArray(body.files)) {
    for (const f of body.files) {
      const rel = safeRel(f && f.path);
      if (!rel) return { code: 400, body: { error: 'bad_path', detail: f && f.path } };
      if (EXT_DENY.has(extOf(rel))) continue;
      let buf; try { buf = Buffer.from(String(f.data_b64 || ''), 'base64'); } catch { return { code: 400, body: { error: 'bad_b64' } }; }
      incoming.push({ rel, buf });
    }
  } else return { code: 400, body: { error: 'no_files' } };
  if (!incoming.length) return { code: 400, body: { error: 'nothing_to_upload' } };
  const existing = new Map((await walk(stageRoot)).map((f) => [f.path, f.bytes]));
  let bytes = [...existing.values()].reduce((a, b) => a + b, 0), count = existing.size;
  for (const it of incoming) {
    if (it.buf.length > CFG.maxFileBytes) return { code: 413, body: { error: 'file_too_large', detail: it.rel } };
    const prev = existing.get(it.rel) || 0;
    if (!existing.has(it.rel)) count += 1;
    bytes += it.buf.length - prev;
    existing.set(it.rel, it.buf.length);
  }
  if (count > CFG.maxFiles) return { code: 413, body: { error: 'too_many_files', max: CFG.maxFiles } };
  if (bytes > CFG.maxSiteBytes) return { code: 413, body: { error: 'quota_exceeded', max: CFG.maxSiteBytes } };
  for (const it of incoming) {
    const dst = path.join(stageRoot, it.rel);
    await mkdir(path.dirname(dst), { recursive: true, mode: 0o755 });
    await writeFile(dst, it.buf, { mode: 0o644 });
  }
  return { code: 200, body: { uploaded: incoming.length } };
}

async function snapshotToBlobstore(handle, files, stageRoot) {
  const zipInput = {};
  for (const f of files) zipInput[f.path] = new Uint8Array(await readFile(`${stageRoot}/${f.path}`));
  const zipped = Buffer.from(zipSync(zipInput));
  const r = await fetch(`${CFG.blobUrl}/`, { method: 'PUT', headers: { authorization: `Bearer ${CFG.blobToken}`, 'content-type': 'application/octet-stream' }, body: zipped, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob_put_failed');
  const j = await r.json().catch(() => ({}));
  return { hash: j.hash || j.sha256 || null, at: new Date().toISOString(), bytes: zipped.length };
}

async function publish(handle) {
  const stageRoot = `${CFG.dir}/${handle}/staging`;
  const files = await walk(stageRoot);
  if (!files.length) throw new Error('empty_site');
  const tmp = `${CFG.dir}/${handle}/.pub-${process.pid}-${createHash('sha1').update(handle + files.length).digest('hex').slice(0, 8)}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o755 });
  const sanitized = [];
  for (const f of files) {
    if (f.path === 'site.json') continue;   // P0-1: the builder model is private — never publish it
    const ext = extOf(f.path);
    const dst = `${tmp}/${f.path}`;
    await mkdir(path.dirname(dst), { recursive: true, mode: 0o755 });
    if (EXT_HTML.has(ext)) { await writeFile(dst, sanitizeHtml(await readFile(`${stageRoot}/${f.path}`, 'utf8')), { mode: 0o644 }); sanitized.push(f.path); }
    else if (ext === 'svg') { await writeFile(dst, sanitizeSvg(await readFile(`${stageRoot}/${f.path}`, 'utf8')), { mode: 0o644 }); sanitized.push(f.path); }
    else if (ext === 'css') { await writeFile(dst, scrubCss(await readFile(`${stageRoot}/${f.path}`, 'utf8')), { mode: 0o644 }); sanitized.push(f.path); }
    else await cp(`${stageRoot}/${f.path}`, dst);
  }
  await chmodTree(tmp, 0o755, 0o644);   // ensure nginx can read every published file
  const pub = `${CFG.dir}/${handle}/published`, old = `${CFG.dir}/${handle}/.published-old`;
  await rm(old, { recursive: true, force: true });
  try { await rename(pub, old); } catch {}
  await rename(tmp, pub);               // atomic swap
  await rm(old, { recursive: true, force: true });
  let snapshot = null;
  if (CFG.blobUrl && CFG.blobToken) { try { snapshot = await snapshotToBlobstore(handle, files, stageRoot); } catch {} }
  const meta = (await loadMeta(handle)) || { handle };
  meta.published_at = new Date().toISOString();
  if (snapshot) meta.snapshots = [snapshot, ...(meta.snapshots || [])].slice(0, 5);
  // Directory card metadata — derived from the published index head so BOTH the
  // visual builder and the #/sitecode editor get indexed. Whitelisted fields only
  // (never owner/contactEmail). theme_color/favicon may be empty (client falls back).
  try {
    const doc = new JSDOM(await readFile(`${pub}/index.html`, 'utf8')).window.document;
    const kw = doc.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
    meta.directory = {
      title: (doc.querySelector('title')?.textContent || '').trim().slice(0, 120),
      description: (doc.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim().slice(0, 300),
      tags: kw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10),
      theme_color: (doc.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '').trim().slice(0, 32),
      favicon: (doc.querySelector('link[rel~="icon"]')?.getAttribute('href') || '').trim().slice(0, 256),
    };
  } catch { meta.directory = {}; }
  if (meta.listed === undefined) meta.listed = true;   // opt-out: listed by default
  await writeFile(`${CFG.dir}/${handle}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  // Fire-and-forget: regenerate the #/explore preview thumbnail. Never blocks/fails publish.
  if (CFG.shotsToken) {
    fetch(`${CFG.shotsUrl}/shot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.shotsToken}` }, body: JSON.stringify({ handle }), signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
  return { published_at: meta.published_at, sanitized };
}

async function unpublish(handle) {
  await rm(`${CFG.dir}/${handle}/published`, { recursive: true, force: true });
  const meta = (await loadMeta(handle)) || { handle };
  meta.published_at = null;
  await writeFile(`${CFG.dir}/${handle}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  return { code: 200, body: { unpublished: handle } };
}

// --- templates + site settings (title / favicon) ---------------------------
async function listTemplates() {
  try { return JSON.parse(await readFile(`${CFG.templatesDir}/templates.json`, 'utf8')); } catch { return []; }
}
async function applyTemplate(handle, id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) return { code: 400, body: { error: 'bad_id' } };
  if (!(await listTemplates()).some((t) => t.id === id)) return { code: 404, body: { error: 'unknown_template' } };
  let html;
  try { html = await readFile(`${CFG.templatesDir}/${id}.html`, 'utf8'); } catch { return { code: 404, body: { error: 'template_missing' } }; }
  await mkdir(`${CFG.dir}/${handle}/staging`, { recursive: true, mode: 0o755 });
  await writeFile(`${CFG.dir}/${handle}/staging/index.html`, html, { mode: 0o644 });
  return { code: 200, body: { applied: id } };
}
// Edit <head> of index.html with jsdom (no script execution): title + favicon.
function applyHead(html, { title, faviconHref }) {
  const doc = new JSDOM(html).window.document;
  if (typeof title === 'string') {
    let t = doc.querySelector('title'); if (!t) { t = doc.createElement('title'); doc.head.appendChild(t); } t.textContent = title;
    let og = doc.querySelector('meta[property="og:title"]'); if (!og) { og = doc.createElement('meta'); og.setAttribute('property', 'og:title'); doc.head.appendChild(og); } og.setAttribute('content', title);
  }
  if (typeof faviconHref === 'string') {
    doc.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
    const link = doc.createElement('link'); link.setAttribute('rel', 'icon'); link.setAttribute('href', faviconHref); doc.head.appendChild(link);
  }
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
async function getSettings(handle) {
  const meta = (await loadMeta(handle)) || {};
  let title = '', favicon = '';
  try { const doc = new JSDOM(await readFile(`${CFG.dir}/${handle}/staging/index.html`, 'utf8')).window.document; title = doc.querySelector('title')?.textContent || ''; favicon = doc.querySelector('link[rel~="icon"]')?.getAttribute('href') || ''; } catch {}
  return { title, favicon, contact_email: meta.contactEmail || '', listed: meta.listed !== false };
}
async function setSettings(handle, b) {
  // Directory visibility (opt-out): owners can hide a published site from #/explore.
  if (typeof b.listed === 'boolean') {
    const meta = (await loadMeta(handle)) || { handle };
    meta.listed = b.listed;
    await writeFile(`${CFG.dir}/${handle}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  }
  // Contact email is PRIVATE: stored in meta.json, NEVER written into any page.
  if (typeof b.contact_email === 'string') {
    const em = b.contact_email.trim();
    if (em && !EMAIL_RE.test(em)) return { code: 400, body: { error: 'bad_email' } };
    const meta = (await loadMeta(handle)) || { handle };
    if (em) meta.contactEmail = em; else delete meta.contactEmail;
    await writeFile(`${CFG.dir}/${handle}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  }
  let html; try { html = await readFile(`${CFG.dir}/${handle}/staging/index.html`, 'utf8'); } catch { return { code: 200, body: { ok: true } }; }
  let faviconHref;
  const emojiRaw = typeof b.favicon_emoji === 'string' ? b.favicon_emoji.trim() : '';
  if (emojiRaw) {
    const emoji = [...emojiRaw][0].replace(/[<>&"']/g, '');
    if (emoji) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="54" font-size="76" text-anchor="middle" dominant-baseline="central">${emoji}</text></svg>`;
      await writeFile(`${CFG.dir}/${handle}/staging/favicon.svg`, svg, { mode: 0o644 });
      faviconHref = '/favicon.svg';
    }
  } else if (typeof b.favicon_b64 === 'string' && b.favicon_b64 && typeof b.favicon_name === 'string') {
    const rel = safeRel(b.favicon_name);
    if (!rel || !/\.(png|ico|svg|jpe?g|gif|webp)$/i.test(rel)) return { code: 400, body: { error: 'bad_favicon' } };
    let buf; try { buf = Buffer.from(b.favicon_b64, 'base64'); } catch { return { code: 400, body: { error: 'bad_b64' } }; }
    if (buf.length > CFG.maxFileBytes) return { code: 413, body: { error: 'file_too_large' } };
    await writeFile(`${CFG.dir}/${handle}/staging/${rel}`, buf, { mode: 0o644 });
    faviconHref = '/' + rel;
  }
  const out = applyHead(html, { title: typeof b.title === 'string' ? b.title.slice(0, 200) : undefined, faviconHref });
  await writeFile(`${CFG.dir}/${handle}/staging/index.html`, out, { mode: 0o644 });
  return { code: 200, body: { ok: true, favicon: faviconHref || null } };
}

// --- contact form (PUBLIC; recipient = owner's meta.contactEmail, never client) ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hdrSafe = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, 400); // kill header injection
function buildFormMime({ to, handle, fields, replyTo }) {
  const dom = CFG.mailDomain, H = (k, v) => k + ': ' + hdrSafe(v) + '\r\n';
  let head = '';
  head += H('From', `Site forms <forms@${dom}>`);
  head += H('To', to);
  if (replyTo && EMAIL_RE.test(replyTo)) head += H('Reply-To', replyTo);
  head += H('Subject', `New message from ${handle}.${CFG.baseDomain}`);
  head += H('Date', new Date().toUTCString());
  head += H('Message-ID', `<${createHash('sha256').update(handle + Date.now() + Math.random()).digest('hex').slice(0, 24)}@${dom}>`);
  head += 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\nAuto-Submitted: auto-generated\r\n\r\n';
  let body = `New form submission on ${handle}.${CFG.baseDomain}\r\n\r\n`;
  for (const [k, v] of Object.entries(fields)) body += `${String(k).slice(0, 80)}: ${String(v).replace(/\r?\n/g, '\n').slice(0, 5000)}\r\n`;
  return head + body;
}
async function formQuotaOk(handle) {
  const day = new Date().toISOString().slice(0, 10), f = `${CFG.dir}/${handle}/.formquota`;
  let q = { date: day, n: 0 };
  try { const j = JSON.parse(await readFile(f, 'utf8')); if (j.date === day) q = j; } catch {}
  if (q.n >= CFG.formDailyMax) return false;
  q.n += 1; await writeFile(f, JSON.stringify(q), { mode: 0o600 }).catch(() => {});
  return true;
}
async function submitForm(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').toLowerCase().split(':')[0];
  const handle = host.split('.')[0];
  if (!handleValid(handle)) return { code: 400, body: { error: 'bad_host' } };
  const meta = await loadMeta(handle);
  if (!meta || !meta.contactEmail || !EMAIL_RE.test(meta.contactEmail)) return { code: 404, body: { error: 'form_not_configured' } };
  let b; try { b = await readBody(req, 64 * 1024); } catch (e) { return { code: e.message === 'too_large' ? 413 : 400, body: { error: e.message } }; }
  if (b && typeof b._hp === 'string' && b._hp.trim()) return { code: 200, body: { sent: true } }; // honeypot -> fake success
  if (typeof b._elapsed === 'number' && b._elapsed < 2500) return { code: 400, body: { error: 'too_fast' } };
  const fields = (b && typeof b.fields === 'object' && b.fields) ? b.fields : {};
  const keys = Object.keys(fields).filter((k) => k !== '_hp' && k !== '_elapsed');
  if (!keys.length || keys.length > 30) return { code: 400, body: { error: 'bad_fields' } };
  let total = 0; const clean = {};
  for (const k of keys) { const v = String(fields[k] ?? ''); total += v.length; clean[String(k).slice(0, 80)] = v.slice(0, 5000); }
  if (total > 20000) return { code: 413, body: { error: 'too_large' } };
  if (!(await formQuotaOk(handle))) return { code: 429, body: { error: 'rate_limited' } };
  if (!CFG.relayToken) return { code: 503, body: { error: 'mail_unavailable' } };
  const replyTo = Object.values(clean).map((v) => String(v).trim()).find((v) => EMAIL_RE.test(v));
  const mime = buildFormMime({ to: meta.contactEmail, handle, fields: clean, replyTo });
  try {
    const r = await fetch(`${CFG.relayUrl}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.relayToken}` },
      body: JSON.stringify({ outbox_id: `siteform-${handle}-${Date.now()}`, mime_b64: Buffer.from(mime, 'utf8').toString('base64'), rcpts: [meta.contactEmail] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { code: 502, body: { error: 'delivery_failed' } };
  } catch { return { code: 502, body: { error: 'delivery_failed' } }; }
  return { code: 200, body: { sent: true } };
}

// --- public site directory (#/explore) -------------------------------------
// In-memory catalog of LISTED, published sites, rebuilt at most every INDEX_TTL.
// Exposes only whitelisted card fields — owner/contactEmail are never included.
const INDEX_TTL = 30000;
let INDEX_CACHE = { at: 0, entries: [] };
async function buildIndex() {
  const entries = [];
  let names = [];
  try { names = (await readdir(CFG.dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch {}
  // Which handles have a generated preview thumbnail (single readdir per rebuild).
  let thumbs = new Set();
  try { thumbs = new Set((await readdir(CFG.shotsDir)).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4))); } catch {}
  for (const handle of names) {
    const meta = await loadMeta(handle);
    if (!meta || !meta.published_at || meta.listed === false) continue;
    const d = meta.directory || {};
    entries.push({
      handle,
      title: String(d.title || handle).slice(0, 120),
      description: String(d.description || '').slice(0, 300),
      tags: Array.isArray(d.tags) ? d.tags.slice(0, 10) : [],
      theme_color: String(d.theme_color || '').slice(0, 32),
      favicon: String(d.favicon || '').slice(0, 256),
      thumb: thumbs.has(handle) ? `/site-thumbs/${handle}.jpg?v=${Date.parse(meta.published_at) || 0}` : null,
      published_at: meta.published_at,
      updated_at: meta.published_at,
      url: `https://${handle}.${CFG.baseDomain}/`,
      _r: createHash('sha1').update(handle).digest('hex'),   // stable shuffle key
    });
  }
  INDEX_CACHE = { at: Date.now(), entries };
  return entries;
}
async function siteIndex(rawUrl) {
  if (Date.now() - INDEX_CACHE.at > INDEX_TTL) await buildIndex();
  const sp = new URL(rawUrl, 'http://x').searchParams;
  const q = (sp.get('q') || '').trim().toLowerCase();
  const tag = (sp.get('tag') || '').trim().toLowerCase();
  const sort = sp.get('sort') || 'new';
  let list = INDEX_CACHE.entries;
  if (q) list = list.filter((s) => `${s.handle} ${s.title} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q));
  if (tag) list = list.filter((s) => s.tags.includes(tag));
  list = list.slice();
  if (sort === 'alpha') list.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  else if (sort === 'random') list.sort((a, b) => (a._r < b._r ? -1 : a._r > b._r ? 1 : 0));
  else list.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))); // new (default)
  const total = list.length;
  const limit = Math.min(48, Math.max(1, parseInt(sp.get('limit') || '24', 10) || 24));
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const start = (page - 1) * limit;
  const sites = list.slice(start, start + limit).map(({ _r, ...s }) => s);
  return { total, page, limit, sort, sites };
}

// --- HTTP ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/sites/')) return J(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && url === '/api/sites/health') return J(res, 200, { ok: true });
    if (req.method === 'POST' && url === '/api/sites/form') { const r = await submitForm(req); return J(res, r.code, r.body); } // PUBLIC: anonymous visitors submit

    const owner = await authOwner(req);
    if (!owner) return J(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url === '/api/sites/me') {
      const handle = await getOwnerHandle(owner);
      if (!handle) return J(res, 200, { handle: null, limits: { maxBytes: CFG.maxSiteBytes, maxFiles: CFG.maxFiles } });
      const meta = await loadMeta(handle);
      return J(res, 200, { handle, published_at: meta?.published_at || null, usage: await usage(handle), url: `https://${handle}.${CFG.baseDomain}/`, limits: { maxBytes: CFG.maxSiteBytes, maxFiles: CFG.maxFiles } });
    }
    if (req.method === 'POST' && url === '/api/sites/claim') {
      const r = await claim(owner, (await readBody(req, 4096)).handle); return J(res, r.code, r.body);
    }
    if (req.method === 'GET' && url === '/api/sites/templates') return J(res, 200, { templates: await listTemplates() });
    if (req.method === 'GET' && url === '/api/sites/index') return J(res, 200, await siteIndex(req.url)); // signed-in browse; no site required

    const handle = await getOwnerHandle(owner);
    if (!handle) return J(res, 409, { error: 'no_site' });

    if (req.method === 'GET' && url === '/api/sites/tree') return J(res, 200, { handle, files: await walk(`${CFG.dir}/${handle}/staging`), usage: await usage(handle) });
    if (req.method === 'GET' && url === '/api/sites/file') {
      const rel = safeRel(new URL(req.url, 'http://localhost').searchParams.get('path') || '');
      if (!rel) return J(res, 400, { error: 'bad_path' });
      try {
        const buf = await readFile(path.join(`${CFG.dir}/${handle}/staging`, rel));
        if (TEXT_EXT.has(extOf(rel))) return J(res, 200, { path: rel, bytes: buf.length, text: buf.toString('utf8') });
        return J(res, 200, { path: rel, bytes: buf.length, data_b64: buf.toString('base64'), binary: true });
      } catch { return J(res, 404, { error: 'not_found' }); }
    }
    if (req.method === 'PUT' && url === '/api/sites/file') { const r = await putFile(handle, await readBody(req)); return J(res, r.code, r.body); }
    if (req.method === 'DELETE' && url === '/api/sites/file') { const r = await delFile(handle, await readBody(req, 4096)); return J(res, r.code, r.body); }
    if (req.method === 'POST' && url === '/api/sites/upload') { const r = await upload(handle, await readBody(req)); return J(res, r.code, r.body); }
    if (req.method === 'POST' && url === '/api/sites/publish') {
      try { const r = await publish(handle); return J(res, 200, { ...r, url: `https://${handle}.${CFG.baseDomain}/` }); }
      catch (e) { return J(res, 400, { error: e.message || 'publish_failed' }); }
    }
    if (req.method === 'POST' && url === '/api/sites/unpublish') { const r = await unpublish(handle); return J(res, r.code, r.body); }
    if (req.method === 'POST' && url === '/api/sites/apply-template') { const r = await applyTemplate(handle, (await readBody(req, 4096)).id); return J(res, r.code, r.body); }
    if (req.method === 'GET' && url === '/api/sites/settings') return J(res, 200, await getSettings(handle));
    if (req.method === 'POST' && url === '/api/sites/settings') { const r = await setSettings(handle, await readBody(req)); return J(res, r.code, r.body); }

    return J(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e.message === 'too_large') return J(res, 413, { error: 'too_large' });
    console.error('req error', e.message); J(res, 500, { error: 'internal' });
  }
});

await mkdir(CFG.dir, { recursive: true });
await mkdir(OWNERS, { recursive: true, mode: 0o700 });
server.listen(CFG.port, '127.0.0.1', () => console.log(`bv-sites on 127.0.0.1:${CFG.port} dir=${CFG.dir} domain=${CFG.baseDomain}`));

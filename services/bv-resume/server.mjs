// bv-resume — owner-keyed Resume Builder backend (separate from the handle-centric
// websites). Stores a structured resume model per registered user, serves a public
// share page at /r/<slug>, and proxies 1-click PDF rendering to bv-shots. Auth is the
// same delegation pattern as bv-sites/bv-schedule: validate the client's Bearer token
// against the API's /api/users/me; the owner key is the token's id-segment.
import http from 'node:http';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const CFG = {
  port: Number(process.env.RESUME_PORT || 8805),
  apiBase: (process.env.API_BASE || 'http://127.0.0.1:8088').replace(/\/+$/, ''),
  baseDomain: (process.env.BASE_DOMAIN || 'yourdomain.com').toLowerCase(),
  dir: process.env.RESUME_DIR || '/var/lib/bv-resume',
  shotsUrl: (process.env.SHOTS_URL || 'http://127.0.0.1:8803').replace(/\/+$/, ''),
  shotsToken: process.env.SHOTS_TOKEN || '',
  maxModelBytes: Number(process.env.MAX_MODEL_BYTES || 3 * 1024 * 1024),
  maxHtmlBytes: Number(process.env.MAX_HTML_BYTES || 3 * 1024 * 1024),
};
const OWNERS = `${CFG.dir}/owners`, SLUGS = `${CFG.dir}/slugs`, SHARED = `${CFG.dir}/shared`;

// --- DOMPurify (server-side via jsdom) — same trust boundary as bv-sites -----
const DOMPurify = createDOMPurify(new JSDOM('').window);
const isExternalUrl = (v) => { const s = String(v || '').trim(); if (s.startsWith('//')) return true; if (/^https?:/i.test(s)) return true; if (/^[a-z][a-z0-9+.\-]*:/i.test(s) && !/^(?:mailto:|tel:|data:)/i.test(s)) return true; return false; };
function scrubCss(css) {
  return String(css || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\1\s*\)/gi, 'url()')
    .replace(/expression\s*\(/gi, '_expr(');
}
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  const tag = (data && data.tagName) || '';
  if (tag === 'meta' && node.getAttribute && ((node.getAttribute('http-equiv') || '').toLowerCase().trim())) node.parentNode && node.parentNode.removeChild(node);
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!node || !node.getAttribute) return;
  const tag = (node.tagName || '').toLowerCase();
  if (tag === 'a') { if ((node.getAttribute('target') || '') === '_blank') node.setAttribute('rel', 'noopener noreferrer'); if (/^\s*\/\//.test(node.getAttribute('href') || '')) node.removeAttribute('href'); }
  if (node.hasAttribute && node.hasAttribute('style')) node.setAttribute('style', scrubCss(node.getAttribute('style')));
  if (tag === 'style') node.textContent = scrubCss(node.textContent || '');
});
const sanitizeHtml = (src) => '<!DOCTYPE html>\n' + DOMPurify.sanitize(src, {
  WHOLE_DOCUMENT: true,
  ADD_TAGS: ['style', 'meta'],
  ADD_ATTR: ['name', 'content', 'charset', 'media'],
  FORBID_TAGS: ['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'base', 'form'],
  FORBID_ATTR: ['http-equiv', 'ping', 'formaction', 'srcdoc'],
  ALLOW_DATA_ATTR: false,
});

// --- slugs -----------------------------------------------------------------
const RESERVED = new Set(['api', 'admin', 'www', 'app', 'r', 'login', 'signup', 'register', 'account', 'assets', 'static', 'health', 'pdf', 'me', 'publish', 'unpublish', 'resume', 'index', 'about', 'help', 'support', 'mail', 'root']);
const BADWORDS = ['fuck', 'shit', 'cunt', 'nigg', 'faggot', 'rape', 'nazi', 'kike', 'spic', 'childporn'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
function slugValid(s) {
  s = String(s || '').toLowerCase();
  if (!SLUG_RE.test(s) || s.includes('--') || s.startsWith('xn--')) return false;
  if (RESERVED.has(s) || BADWORDS.some((w) => s.includes(w))) return false;
  return true;
}

// --- auth (delegate to API /api/users/me; owner = token id-segment) ---------
async function authOwner(req) {
  const auth = req.headers['authorization'] || '';
  if (!/^Bearer\s+\S/.test(auth)) { console.error('authOwner: no Bearer token in request'); return null; }
  let r;
  try { r = await fetch(`${CFG.apiBase}/api/users/me`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) }); }
  catch (e) { console.error('authOwner: fetch /api/users/me threw:', e && e.message); return null; }
  if (r.status !== 200) {
    let body = ''; try { body = await r.text(); } catch {}
    console.error('authOwner: /api/users/me returned', r.status, body.slice(0, 200));
    return null;
  }
  const token = auth.replace(/^Bearer\s+/, '').trim();
  const owner = token.split('.')[0]; // id segment, verified valid by the API above
  // identityIdB64 is STANDARD base64 (btoa, padding stripped), so it contains
  // A-Za-z0-9+/ only. owner is a sha256 hash input / JSON value, never a path.
  if (!owner || owner.length < 8 || owner.length > 200) {
    console.error('authOwner: owner length out of range:', owner && owner.length);
    return null;
  }
  return owner;
}

// --- helpers ---------------------------------------------------------------
const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const ownerHash = (owner) => createHash('sha256').update(owner).digest('hex');
const ownerDir = (owner) => `${OWNERS}/${ownerHash(owner)}`;
const slugFile = (slug) => `${SLUGS}/${slug}`;
async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function readBody(req, cap) { let n = 0; const chunks = []; for await (const c of req) { n += c.length; if (n > cap) throw new Error('too_large'); chunks.push(c); } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
const loadMeta = (owner) => readJson(`${ownerDir(owner)}/meta.json`);
async function slugOwner(slug) { try { return (await readFile(slugFile(slug), 'utf8')).trim() || null; } catch { return null; } }

async function publish(owner, body) {
  const slug = String(body.slug || '').toLowerCase();
  if (!slugValid(slug)) return { code: 400, body: { error: 'invalid_slug' } };
  const html = String(body.html || '');
  if (html.length < 40 || html.length > CFG.maxHtmlBytes) return { code: 400, body: { error: 'bad_html' } };
  const mine = ownerHash(owner);
  const taken = await slugOwner(slug);
  if (taken && taken !== mine) return { code: 409, body: { error: 'slug_taken' } };
  // Free a previous slug if the owner is changing it.
  const meta = (await loadMeta(owner)) || { owner };
  if (meta.slug && meta.slug !== slug) { await rm(slugFile(meta.slug), { force: true }).catch(() => {}); await rm(`${SHARED}/${meta.slug}.html`, { force: true }).catch(() => {}); }
  await mkdir(SHARED, { recursive: true, mode: 0o755 });
  await writeFile(`${SHARED}/${slug}.html`, sanitizeHtml(html), { mode: 0o644 });
  await mkdir(SLUGS, { recursive: true });
  await writeFile(slugFile(slug), mine, { mode: 0o600 });
  meta.owner = owner; meta.slug = slug; meta.published_at = new Date().toISOString();
  await mkdir(ownerDir(owner), { recursive: true, mode: 0o700 });
  await writeFile(`${ownerDir(owner)}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  return { code: 200, body: { url: `https://${CFG.baseDomain}/r/${slug}`, slug } };
}

async function unpublish(owner) {
  const meta = await loadMeta(owner);
  if (meta && meta.slug) { await rm(slugFile(meta.slug), { force: true }).catch(() => {}); await rm(`${SHARED}/${meta.slug}.html`, { force: true }).catch(() => {}); meta.slug = null; meta.published_at = null; await writeFile(`${ownerDir(owner)}/meta.json`, JSON.stringify(meta), { mode: 0o600 }); }
  return { code: 200, body: { ok: true } };
}

async function toPdf(owner, html, res) {
  if (!html || html.length < 40 || html.length > CFG.maxHtmlBytes) return J(res, 400, { error: 'bad_html' });
  if (!CFG.shotsToken) return J(res, 503, { error: 'pdf_unavailable' });
  const clean = sanitizeHtml(html);
  let r;
  try { r = await fetch(`${CFG.shotsUrl}/pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.shotsToken}` }, body: JSON.stringify({ html: clean }), signal: AbortSignal.timeout(40000) }); }
  catch { return J(res, 502, { error: 'pdf_failed' }); }
  if (!r.ok) return J(res, 502, { error: 'pdf_failed' });
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="resume.pdf"', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}

// --- HTTP ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/resume/')) return J(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && url === '/api/resume/health') return J(res, 200, { ok: true });

    // PDF rendering is available signed-out so the résumé builder is usable
    // without an account. It is owner-agnostic (sanitised HTML -> bv-shots) and
    // size-capped, so no Bearer is required.
    if (req.method === 'POST' && url === '/api/resume/pdf') {
      let body; try { body = await readBody(req, CFG.maxHtmlBytes + 65536); } catch (e) { return J(res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_body' }); }
      return toPdf(null, String((body && body.html) || ''), res);
    }

    const owner = await authOwner(req);
    if (!owner) return J(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url === '/api/resume/me') {
      const model = await readJson(`${ownerDir(owner)}/resume.json`);
      const meta = await loadMeta(owner);
      const published = meta && meta.slug ? { slug: meta.slug, url: `https://${CFG.baseDomain}/r/${meta.slug}`, at: meta.published_at || null } : null;
      return J(res, 200, { model, published, limits: { maxBytes: CFG.maxModelBytes } });
    }
    if (req.method === 'GET' && url === '/api/resume/slug-available') {
      const slug = String(new URL(req.url, 'http://localhost').searchParams.get('slug') || '').toLowerCase();
      if (!slugValid(slug)) return J(res, 200, { available: false, reason: 'invalid' });
      const taken = await slugOwner(slug);
      return J(res, 200, { available: !taken || taken === ownerHash(owner) });
    }
    if (req.method === 'PUT' && url === '/api/resume/me') {
      let body; try { body = await readBody(req, CFG.maxModelBytes); } catch (e) { return J(res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_body' }); }
      if (!body || typeof body.model !== 'object' || body.model === null) return J(res, 400, { error: 'bad_model' });
      await mkdir(ownerDir(owner), { recursive: true, mode: 0o700 });
      await writeFile(`${ownerDir(owner)}/resume.json`, JSON.stringify(body.model), { mode: 0o600 });
      return J(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/resume/publish') {
      let body; try { body = await readBody(req, CFG.maxHtmlBytes + 65536); } catch (e) { return J(res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_body' }); }
      const r = await publish(owner, body || {}); return J(res, r.code, r.body);
    }
    if (req.method === 'POST' && url === '/api/resume/unpublish') { const r = await unpublish(owner); return J(res, r.code, r.body); }
    return J(res, 404, { error: 'not_found' });
  } catch (e) { if (e && e.message === 'too_large') return J(res, 413, { error: 'too_large' }); console.error('req error', e && e.message); J(res, 500, { error: 'internal' }); }
});

await mkdir(OWNERS, { recursive: true, mode: 0o700 });
await mkdir(SLUGS, { recursive: true, mode: 0o700 });
await mkdir(SHARED, { recursive: true, mode: 0o755 });
server.listen(CFG.port, '127.0.0.1', () => console.log(`bv-resume on 127.0.0.1:${CFG.port} dir=${CFG.dir} domain=${CFG.baseDomain}`));

// bv-shots — on-demand homepage screenshots for the #/explore directory.
// Tiny HTTP service (127.0.0.1): bv-sites fire-and-forgets POST /shot {handle}
// after each publish. We spawn Chromium ON DEMAND (closed after each drain — zero
// idle browser RAM), serialize renders single-flight, and write a 4:3 above-the-fold
// JPEG to SHOTS_DIR/<handle>.jpg. Render target is the LOCAL, pre-sanitized,
// JS-disabled published site (subdomains mapped to 127.0.0.1), so no untrusted code runs.
import http from 'node:http';
import { chromium } from 'playwright';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CFG = {
  port: Number(process.env.SHOTS_PORT || 8803),
  token: process.env.SHOTS_TOKEN || '',
  dir: process.env.SHOTS_DIR || '/var/lib/bv-shots/thumbs',
  baseDomain: (process.env.BASE_DOMAIN || 'yourdomain.com').toLowerCase(),
  width: Number(process.env.SHOTS_WIDTH || 1024),
  height: Number(process.env.SHOTS_HEIGHT || 768),   // 1024x768 = 4:3 above-the-fold
  quality: Number(process.env.SHOTS_QUALITY || 72),
};
// Same handle rule bv-sites uses (3..32, no edge hyphen). No SSRF: the URL is built
// server-side from a validated handle and only ever resolves to localhost.
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

// ---- global serialization: only ONE Chromium at a time (shots OR pdf) -----
// Respects the service MemoryMax cap; shot batches and PDF renders never overlap.
let lock = Promise.resolve();
const withLock = (fn) => { const p = lock.then(fn, fn); lock = p.then(() => {}, () => {}); return p; };

// ---- screenshot queue (fire-and-forget) -----------------------------------
const pending = new Set();
let running = false;
async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const batch = [...pending]; for (const h of batch) pending.delete(h);
      await withLock(async () => {
        let browser = null;
        try {
          browser = await chromium.launch({ args: ['--no-sandbox', `--host-resolver-rules=MAP ${CFG.baseDomain} 127.0.0.1, MAP *.${CFG.baseDomain} 127.0.0.1`, '--ignore-certificate-errors'] });
          const ctx = await browser.newContext({ viewport: { width: CFG.width, height: CFG.height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, javaScriptEnabled: false });
          const page = await ctx.newPage();
          for (const handle of batch) {
            try {
              await page.goto(`https://${handle}.${CFG.baseDomain}/`, { waitUntil: 'load', timeout: 15000 });
              await page.waitForTimeout(400);
              const buf = await page.screenshot({ type: 'jpeg', quality: CFG.quality, clip: { x: 0, y: 0, width: CFG.width, height: CFG.height } });
              const dst = path.join(CFG.dir, `${handle}.jpg`), tmp = `${dst}.tmp`;
              await writeFile(tmp, buf, { mode: 0o644 });
              await rename(tmp, dst);
              console.log(`shot ok ${handle} (${buf.length}b)`);
            } catch (e) { console.error(`shot fail ${handle}: ${String(e.message || e).split('\n')[0]}`); }
          }
          await ctx.close();
        } catch (e) { console.error(`browser launch fail: ${String(e.message || e).split('\n')[0]}`); }
        finally { if (browser) { try { await browser.close(); } catch {} } }
      });
    }
  } finally {
    running = false;
    if (pending.size) drain();
  }
}

// ---- PDF render (await-and-return) ----------------------------------------
// Renders self-contained HTML (inline CSS, data-URI images) to an A4 PDF. JS is
// disabled and content is set directly (no network), so nothing untrusted runs.
async function renderPdf(html) {
  return withLock(async () => {
    let browser = null;
    try {
      browser = await chromium.launch({ args: ['--no-sandbox', '--ignore-certificate-errors'] });
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
      await page.waitForTimeout(150);
      const buf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
      await ctx.close();
      return buf;
    } finally { if (browser) { try { await browser.close(); } catch {} } }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/health') return J(res, 200, { ok: true, pending: pending.size, running });
    if (req.method === 'POST' && url === '/shot') {
      const auth = req.headers['authorization'] || '';
      if (!CFG.token || auth !== `Bearer ${CFG.token}`) return J(res, 401, { error: 'unauthorized' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return J(res, 413, { error: 'too_large' }); }
      let handle; try { handle = String(JSON.parse(body || '{}').handle || '').toLowerCase(); } catch { return J(res, 400, { error: 'bad_json' }); }
      if (!HANDLE_RE.test(handle)) return J(res, 400, { error: 'bad_handle' });
      pending.add(handle); drain();
      return J(res, 202, { queued: true, handle });
    }
    if (req.method === 'POST' && url === '/pdf') {
      const auth = req.headers['authorization'] || '';
      if (!CFG.token || auth !== `Bearer ${CFG.token}`) return J(res, 401, { error: 'unauthorized' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 4 * 1024 * 1024) return J(res, 413, { error: 'too_large' }); }
      let html; try { html = String(JSON.parse(body || '{}').html || ''); } catch { return J(res, 400, { error: 'bad_json' }); }
      if (html.length < 20) return J(res, 400, { error: 'no_html' });
      try {
        const buf = await renderPdf(html);
        res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-length': buf.length });
        return res.end(buf);
      } catch (e) { console.error(`pdf fail: ${String(e.message || e).split('\n')[0]}`); return J(res, 500, { error: 'pdf_failed' }); }
    }
    return J(res, 404, { error: 'not_found' });
  } catch (e) { J(res, 500, { error: 'internal' }); }
});

await mkdir(CFG.dir, { recursive: true, mode: 0o755 });
if (!CFG.token) console.error('WARNING: SHOTS_TOKEN not set — /shot will reject all requests');
server.listen(CFG.port, '127.0.0.1', () => console.log(`bv-shots on 127.0.0.1:${CFG.port} dir=${CFG.dir} domain=${CFG.baseDomain}`));

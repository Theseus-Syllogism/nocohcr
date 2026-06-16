// Minimal content-addressable blobstore for blindvault (CT171 role).
// Stores opaque ciphertext blobs keyed by their sha256. Both the API (vault
// files) and bv-inbox-smtp (inbox bodies) PUT/GET by hash. Bearer-token auth.
//
// Path-tolerant: keys by the DECODED hash of the LAST path segment (accepts
// 64-char hex or base64/base64url), so it works regardless of the client's
// exact URL prefix or hash encoding. Never logs the auth token.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DIR = process.env.BLOBSTORE_DIR || '/var/lib/bv-blobstore';
const TOKEN = process.env.BLOBSTORE_TOKEN || '';
const PORT = Number(process.env.BLOBSTORE_PORT || 8799);
const MAX = Number(process.env.BLOBSTORE_MAX_BYTES || 8 * 1024 * 1024);
if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });

// last path segment -> canonical 64-char lowercase hex key (or null)
function keyOf(url) {
  const seg = decodeURIComponent((url.split('?')[0].split('/').filter(Boolean).pop()) || '');
  if (/^[0-9a-fA-F]{64}$/.test(seg)) return seg.toLowerCase();
  try { const b = Buffer.from(seg.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); if (b.length === 32) return b.toString('hex'); } catch {}
  return null;
}
const ok = (req) => TOKEN && req.headers['authorization'] === `Bearer ${TOKEN}`;
const log = (req, status, extra='') => console.log(`${req.method} ${req.url.split('?')[0]} ${status}${extra}`);

http.createServer(async (req, res) => {
  try {
    if (!ok(req)) { res.writeHead(401); res.end('unauthorized'); return log(req, 401); }
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && (path === '/list' || path === '/v1/list')) {
      const files = (await readdir(DIR)).filter(f => /^[0-9a-f]{64}$/.test(f));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]'); return log(req, 200, ' (gc-safe empty list)');
    }
    const key = keyOf(path);
    if (!key) { res.writeHead(400); res.end('bad key'); return log(req, 400); }
    const file = `${DIR}/${key}`;
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > MAX) { res.writeHead(413); res.end('too large'); return log(req, 413); } chunks.push(c); }
      const body = Buffer.concat(chunks);
      const actual = createHash('sha256').update(body).digest('hex');
      // content-addressable integrity: stored name is always the real hash
      await writeFile(`${DIR}/${actual}`, body);
      res.writeHead(201, { 'content-type': 'text/plain' }); res.end(actual);
      return log(req, 201, key === actual ? '' : ` (stored as ${actual.slice(0,8)})`);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try { const body = await readFile(file);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body); return log(req, 200, ` (${body.length}b)`);
      } catch { res.writeHead(404); res.end('not found'); return log(req, 404); }
    }
    if (req.method === 'DELETE') {
      try { await unlink(file); } catch {}
      res.writeHead(204); res.end(); return log(req, 204);
    }
    res.writeHead(405); res.end('method not allowed'); log(req, 405);
  } catch (e) { res.writeHead(500); res.end('error'); console.log(`ERR ${e.message}`); }
}).listen(PORT, '127.0.0.1', () => console.log(`bv-blobstore on 127.0.0.1:${PORT} dir=${DIR}`));

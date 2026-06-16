import { chromium } from 'playwright';

const CASES = [
  ['www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['youtube.com/watch?v=jNQXAC9IVRw',     'https://youtube.com/watch?v=jNQXAC9IVRw'],
  ['://www.youtube.com/watch?v=abc',       'https://www.youtube.com/watch?v=abc'],
  ['//www.youtube.com/watch?v=abc',        'https://www.youtube.com/watch?v=abc'],
  ['https://www.youtube.com/watch?v=keep', 'https://www.youtube.com/watch?v=keep'],
  ['  archive.org/details/x  ',            'https://archive.org/details/x'],
];

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
// block the service worker so we always exercise the freshly-deployed bundle
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
const page = await ctx.newPage();

let sentUrl = null;
await page.route('**/api/download/start', async (route) => {
  try { sentUrl = route.request().postDataJSON()?.url ?? null; } catch { sentUrl = null; }
  // stop the flow immediately after capture (no real download)
  await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'intercepted-by-test' }) });
});

await page.goto('https://yourdomain.com/#/digital-resources', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('#bv-dl-url', { timeout: 15000 });

let pass = 0, fail = 0;
for (const [input, expected] of CASES) {
  sentUrl = null;
  await page.fill('#bv-dl-url', input);
  await page.click('#bv-dl-submit');
  await page.waitForFunction(() => window.__lastSent !== undefined, null, { timeout: 100 }).catch(() => {});
  // wait for the intercepted request
  await page.waitForTimeout(400);
  const reflected = await page.inputValue('#bv-dl-url');
  const ok = sentUrl === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} | in="${input.trim()}" -> sent="${sentUrl}" | input-now="${reflected}"${ok ? '' : `  (expected ${expected})`}`);
  ok ? pass++ : fail++;
  // reset for next case
  await page.click('#bv-dl-reset').catch(() => {});
  await page.fill('#bv-dl-url', '').catch(() => {});
}
console.log(`\n${pass}/${CASES.length} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

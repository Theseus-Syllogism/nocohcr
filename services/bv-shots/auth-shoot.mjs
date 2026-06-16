import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const HANDLE = process.env.BV_H, PW = process.env.BV_P;
const OUT = '/opt/bv-shots/shots-auth';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// --- log in ---
await page.goto('https://yourdomain.com/#/login', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForTimeout(1000);
try {
  await page.locator('input[type="password"]').first().waitFor({ timeout: 8000 });
  const handleField = page.locator('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])').first();
  await handleField.fill(HANDLE);
  await page.locator('input[type="password"]').first().fill(PW);
  await page.getByRole('button', { name: /^\s*unlock/i }).first().click();
  console.log('clicked Unlock; waiting for vault to decrypt…');
  await page.waitForTimeout(7000); // argon2/crypto can be slow
} catch (e) { console.log('LOGIN STEP ERROR: ' + e.message.split('\n')[0]); }

// did we get in? heuristic: the Unlock button is gone
const stillLogin = await page.getByRole('button', { name: /^\s*unlock/i }).count().catch(() => 0);
console.log(stillLogin ? 'WARNING: still on login (unlock failed?)' : 'login appears successful');

// --- definitive tier probe: the bug was tier stuck at "anonymous" after unlock ---
await page.goto('https://yourdomain.com/#/dashboard', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForTimeout(2500);
const probe = await page.evaluate(() => {
  const ha = document.querySelector('#bv-header-actions');
  const txt = (document.body.innerText || '');
  return {
    headerTier: ha ? ha.dataset.tier : '(no #bv-header-actions)',
    headerHTML: ha ? ha.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    sidebarHasSignIn: /Sign in|Create account/i.test(txt),
  };
});
console.log('TIER PROBE => ' + JSON.stringify(probe));

async function shot(name, route, vp) {
  const w = vp === 'mobile' ? 390 : 1280, h = vp === 'mobile' ? 844 : 900;
  await page.setViewportSize({ width: w, height: h });
  try {
    await page.goto('https://yourdomain.com/' + route, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/${name}-${vp}.png`, fullPage: vp === 'desktop' });
    console.log('OK  ' + name + '-' + vp);
  } catch (e) { console.log('ERR ' + name + '-' + vp + ': ' + e.message.split('\n')[0]); }
}

const ROUTES = [
  ['home', '#/dashboard'],
  ['mysite', '#/site'],
  ['inbox', '#/inbox'],
  ['messages', '#/messages'],
  ['board', '#/board'],
  ['vault', '#/vault'],
  ['documents', '#/documents'],
];
for (const [n, r] of ROUTES) { await shot(n, r, 'desktop'); }
for (const [n, r] of [['mysite', '#/site'], ['home', '#/dashboard'], ['board', '#/board']]) { await shot(n, r, 'mobile'); }
await browser.close();
console.log('done');

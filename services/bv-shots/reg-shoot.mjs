import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const OUT = '/opt/bv-shots/shots-reg';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const log = [];
page.on('console', m => log.push(`CONSOLE[${m.type()}] ${m.text()}`.slice(0, 300)));
page.on('pageerror', e => log.push('PAGEERROR ' + e.message.split('\n')[0]));
page.on('requestfinished', async r => { const u = r.url(); if (u.includes('/api/')) { try { const rs = await r.response(); log.push(`NET ${r.method()} ${u.replace('https://yourdomain.com','')} -> ${rs ? rs.status() : '?'}`); } catch {} } });
page.on('requestfailed', r => { const u = r.url(); if (u.includes('/api/')) log.push(`NET-FAIL ${r.method()} ${u.replace('https://yourdomain.com','')} : ${r.failure()?.errorText}`); });

const shot = async n => { try { await page.screenshot({ path: `${OUT}/${n}.png` }); } catch {} };
const txt = async () => (await page.evaluate(() => document.querySelector('main')?.innerText || '').catch(() => '')).replace(/\n+/g, ' | ').slice(0, 200);

try {
  await page.goto('https://yourdomain.com/#/setup', { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(1200);
  log.push('STEP lang: ' + await txt()); await shot('1-lang');
  // language: pick English
  if (await page.locator('#bv-lang-en').count()) await page.locator('#bv-lang-en').click();
  // continue/next
  for (const sel of ['#bv-next', 'button.bv-primary']) { if (await page.locator(sel).first().count()) { await page.locator(sel).first().click(); break; } }
  await page.waitForTimeout(800);

  // handle
  log.push('STEP handle: ' + await txt());
  const handle = 'diag' + Date.now().toString().slice(-7);
  await page.locator('#bv-handle').fill(handle);
  await page.waitForTimeout(2500); // availability check
  await shot('2-handle');
  await page.locator('#bv-next, button.bv-primary').first().click();
  await page.waitForTimeout(1200);

  // phrase: read the 12 words
  log.push('STEP phrase: ' + await txt());
  const phrase = await page.evaluate(() => Array.from(document.querySelectorAll('.bv-phrase-list code')).map(c => c.textContent.trim()));
  log.push('PHRASE words=' + phrase.length + ' first=' + phrase[0]);
  await shot('3-phrase');
  await page.locator('#bv-next, button.bv-primary').first().click();
  await page.waitForTimeout(1000);

  // confirm: read which positions are asked, fill from phrase
  log.push('STEP confirm: ' + await txt());
  const inputs = await page.locator('#bv-confirm-host input').elementHandles();
  for (const h of inputs) {
    const aria = (await h.getAttribute('aria-label')) || (await h.getAttribute('placeholder')) || '';
    const m = aria.match(/(\d+)/);
    if (m) { const pos = parseInt(m[1], 10); await h.fill(phrase[pos - 1] || ''); }
  }
  await page.waitForTimeout(600); await shot('4-confirm');
  await page.locator('#bv-next, button.bv-primary').first().click();
  await page.waitForTimeout(1000);

  // password sub-screen
  log.push('STEP password: ' + await txt());
  if (await page.locator('#bv-pass, input[type=password]').first().count()) {
    const pws = page.locator('input[type=password]');
    const n = await pws.count();
    await pws.nth(0).fill('DiagPassw0rd!');
    if (n > 1) await pws.nth(1).fill('DiagPassw0rd!');
    await shot('5-password');
    await page.locator('#bv-next, button.bv-primary').first().click();
    await page.waitForTimeout(1000);
  }

  // worker sub-screen -> SKIP (triggers finalize x(null))
  log.push('STEP worker: ' + await txt());
  await shot('6-worker');
  // main-thread liveness probe: a healthy UI ticks ~10x/sec; a frozen thread won't
  await page.evaluate(() => { window.__ticks = 0; window.__t0 = performance.now(); window.__iv = setInterval(() => window.__ticks++, 100); });
  const t0 = Date.now();
  if (await page.locator('#bv-skip').count()) await page.locator('#bv-skip').click();
  else await page.locator('button.bv-primary').first().click();

  await page.waitForTimeout(2000); await shot('6b-finalizing'); // capture spinner state mid-derivation
  // watch finalize for up to 40s, sampling the status line
  let done = false, lastStatus = '';
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const fin = await page.evaluate(() => document.querySelector('#bv-finalize')?.textContent || '').catch(() => '');
    const body = await txt();
    if (fin !== lastStatus) { log.push(`  +${i + 1}s finalize="${fin}"`); lastStatus = fin; }
    if (/All set|✅|recovery|\.yourdomain\.com/.test(body) || page.url().includes('login')) { done = true; log.push(`FINALIZE DONE at +${((Date.now() - t0) / 1000).toFixed(1)}s url=${page.url()}`); break; }
  }
  if (!done) log.push(`FINALIZE STUCK after 40s; lastStatus="${lastStatus}"`);
  const live = await page.evaluate(() => { const el = (performance.now() - window.__t0) / 1000; clearInterval(window.__iv); return { elapsed: el.toFixed(1), ticks: window.__ticks, expectedTicks: Math.round(el * 10) }; }).catch(() => null);
  if (live) log.push(`MAIN-THREAD LIVENESS: ${live.ticks} ticks vs ${live.expectedTicks} expected over ${live.elapsed}s  (low ratio = UI frozen)`);
  await shot('7-finalize');
  log.push('FINAL body: ' + await txt());
  // AUTO-LOGIN CHECK: session set + "Open my vault" lands authenticated, not on login
  const tierAfterReg = await page.evaluate(() => document.querySelector('#bv-header-actions')?.dataset.tier || '(none)').catch(() => '?');
  log.push('SESSION after register: header tier=' + tierAfterReg);
  if (await page.locator('#bv-go').count()) { await page.locator('#bv-go').click(); await page.waitForTimeout(2500); }
  const landing = { url: page.url(), tier: await page.evaluate(() => document.querySelector('#bv-header-actions')?.dataset.tier || '(none)').catch(() => '?'), signIn: await page.evaluate(() => /Sign in|Create account/i.test(document.body.innerText)).catch(() => null) };
  log.push('AFTER "Open my vault": ' + JSON.stringify(landing));
  await shot('8-landing');
} catch (e) {
  log.push('SCRIPT ERROR: ' + e.message.split('\n')[0]);
  await shot('error');
}
console.log(log.join('\n'));
await browser.close();

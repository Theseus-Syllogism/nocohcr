import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

await mkdir('/opt/bv-shots/shots-resumeanon', { recursive: true });
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// Anonymous resume page
await page.goto('https://yourdomain.com/#/resume', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: '/opt/bv-shots/shots-resumeanon/resume-anon.png', fullPage: true });

const builderPresent = await page.locator('.bvr').count();
const signInGate = (await page.locator('text=to build and share your').count());
const statusText = await page.locator('.bvr-status').textContent().catch(() => '(none)');
const pdfBtn = await page.locator('.bvr-btn:has-text("PDF")').count();
console.log('RESUME builderPresent=' + builderPresent + ' signInGate=' + signInGate + ' status="' + (statusText||'').trim() + '" pdfBtn=' + pdfBtn);

// Sidebar: Digital Resources section contents + lock check on Resume
await page.goto('https://yourdomain.com/#/resources', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);
const digital = await page.evaluate(() => {
  const sec = document.querySelector('.bv-sidebar section[data-section="digital"]');
  if (!sec) return { found: false };
  const title = sec.querySelector('.bv-nav-section-title')?.textContent?.trim();
  const items = [...sec.querySelectorAll('li[data-id]')].map(li => ({
    id: li.dataset.id,
    label: li.querySelector('span')?.textContent?.trim(),
    gated: li.dataset.gated === 'true',
    hasLock: !!li.querySelector('.bv-nav-lock'),
  }));
  return { found: true, title, items };
});
const personal = await page.evaluate(() => {
  const sec = document.querySelector('.bv-sidebar section[data-section="personal"]');
  if (!sec) return { found: false };
  return { found: true, ids: [...sec.querySelectorAll('li[data-id]')].map(li => li.dataset.id) };
});
console.log('DIGITAL ' + JSON.stringify(digital));
console.log('PERSONAL ' + JSON.stringify(personal));
await page.screenshot({ path: '/opt/bv-shots/shots-resumeanon/sidebar.png', fullPage: false });

await ctx.close();
await browser.close();
console.log('done');

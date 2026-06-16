import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

await mkdir('/opt/bv-shots/shots-digitalres', { recursive: true });
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// ---- LOGGED-OUT landing: inspect sidebar ----
await page.goto('https://yourdomain.com/#/resources', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1800);

const nav = await page.evaluate(() => {
  const sb = document.querySelector('.bv-sidebar');
  const sections = [...(sb?.querySelectorAll('.bv-nav-section') || [])].map(s => ({
    section: s.dataset.section,
    title: s.querySelector('.bv-nav-section-title')?.textContent?.trim(),
    items: [...s.querySelectorAll('li[data-id]')]
      .filter(li => !li.hidden)
      .map(li => ({ id: li.dataset.id, label: li.querySelector('a span')?.textContent?.trim(), gated: li.dataset.gated === 'true' }))
  }));
  return {
    sections,
    crisisInSidebar: !!document.querySelector('.bv-sidebar .bv-crisis-trigger'),
    crisisInMasthead: !!document.querySelector('.bv-masthead .bv-crisis-trigger'),
  };
});
console.log('NAV =', JSON.stringify(nav, null, 2));

// open the hamburger so the screenshot shows the sidebar
const tog = await page.$('.bv-navtoggle');
if (tog) { await tog.click().catch(()=>{}); await page.waitForTimeout(500); }
await page.screenshot({ path: '/opt/bv-shots/shots-digitalres/sidebar-loggedout.png', fullPage: false });

// ---- LOGGED-OUT #/library: must NOT redirect to login ----
await page.goto('https://yourdomain.com/#/library', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);
const lib = await page.evaluate(() => ({
  hash: location.hash,
  hasLibrary: !!document.querySelector('.bv-library'),
  note: document.querySelector('#bv-library-note')?.textContent?.trim()?.slice(0, 90),
  filmsSection: !!document.querySelector('#bv-dr-films'),
  routeAttr: document.querySelector('#bv-app')?.getAttribute('data-route'),
}));
console.log('LIBRARY =', JSON.stringify(lib, null, 2));
await page.screenshot({ path: '/opt/bv-shots/shots-digitalres/library-loggedout.png', fullPage: true });

// ---- LOGGED-OUT #/digital-resources: public page ----
await page.goto('https://yourdomain.com/#/digital-resources', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1800);
const dr = await page.evaluate(() => ({
  hash: location.hash,
  hasPage: !!document.querySelector('.bv-dr'),
  routeAttr: document.querySelector('#bv-app')?.getAttribute('data-route'),
}));
console.log('DIGITAL-RESOURCES =', JSON.stringify(dr, null, 2));
await page.screenshot({ path: '/opt/bv-shots/shots-digitalres/digital-resources-loggedout.png', fullPage: false });

await browser.close();
console.log('done');

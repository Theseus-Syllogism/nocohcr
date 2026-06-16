import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const ROUTES = [
  ['landing', '/'],
  ['login', '/#/login'],
  ['about', '/#/about'],
  ['mysite', '/#/site'],
];
const VIEWPORTS = [['desktop', 1280, 900], ['mobile', 390, 844]];

await mkdir('/opt/bv-shots/shots', { recursive: true });
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP yourdomain.com 127.0.0.1, MAP *.yourdomain.com 127.0.0.1', '--ignore-certificate-errors'] });
for (const [vp, w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  for (const [name, route] of ROUTES) {
    try {
      await page.goto('https://yourdomain.com' + route, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(1500);
      const file = `/opt/bv-shots/shots/${name}-${vp}.png`;
      await page.screenshot({ path: file, fullPage: vp === 'desktop' });
      const title = await page.title().catch(() => '');
      console.log('OK  ' + name + '-' + vp + '  title="' + title + '"');
    } catch (e) { console.log('ERR ' + name + '-' + vp + ': ' + e.message.split('\n')[0]); }
  }
  await ctx.close();
}
await browser.close();
console.log('done');

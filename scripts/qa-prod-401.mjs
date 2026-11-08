import { chromium } from './lib/playwright.mjs';

const base = 'https://framecall.site';
const browser = await chromium.launch();
const page = await browser.newPage();

const bad = [];
page.on('response', (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

for (const path of ['/', '/models', '/docs', '/pricing', '/privacy', '/terms', '/how-it-works']) {
  bad.length = 0;
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(500);
  console.log(`${path}: ${bad.length === 0 ? 'no failed requests' : bad.join(' | ')}`);
}

bad.length = 0;
await page.goto(`${base}/app`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(1200);
console.log(`/app: ${bad.length === 0 ? 'no failed requests' : bad.join(' | ')}`);
console.log('final url:', page.url());

await browser.close();

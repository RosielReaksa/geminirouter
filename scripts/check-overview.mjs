import { chromium } from './lib/playwright.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

await page.screenshot({
  path: 'D:/projectradom/geminirouter/out-overview.png',
  fullPage: true,
});

// Report what actually rendered
const info = await page.evaluate(() => {
  const text = document.body.innerText;
  const has = (s) => text.includes(s);
  return {
    heading: has('Everything, at a glance.'),
    pauseButtonGone: !has('Pause Gateway'),
    alwaysOn: has('Always-On'),
    accountPool: has('Account Pool'),
    routing: has('Routing'),
    models: has('Models'),
    recent: has('Recent Activity'),
    volume: has('Request Volume'),
    bodyLen: text.length,
  };
});

console.log('RENDER:', JSON.stringify(info, null, 2));
console.log('CONSOLE ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

await browser.close();

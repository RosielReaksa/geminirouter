import { chromium } from 'file:///D:/projectradom/AntigravityManager/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });

const pages = [
  ['/', 'home'],
  ['/models', 'models'],
  ['/pricing', 'pricing'],
  ['/docs', 'docs'],
  ['/privacy', 'privacy'],
  ['/login', 'login'],
  ['/nope-404', 'notfound'],
];

const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

for (const [path, name] of pages) {
  await page.goto('http://127.0.0.1:3000' + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: `D:/projectradom/geminirouter/qa-${name}.png`,
    fullPage: true,
  });

  const info = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.slice(0, 60) || null,
    len: document.body.innerText.length,
    navPresent: !!document.querySelector('header'),
    footerPresent: !!document.querySelector('footer'),
  }));
  console.log(`${name.padEnd(10)} ${JSON.stringify(info)}`);
}

console.log('\nCONSOLE ERRORS:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();

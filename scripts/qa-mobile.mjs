import { chromium } from './lib/playwright.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

for (const [path, name] of [
  ['/', 'home'],
  ['/models', 'models'],
  ['/pricing', 'pricing'],
  ['/docs', 'docs'],
]) {
  await page.goto('http://127.0.0.1:3000' + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.screenshot({
    path: `D:/projectradom/geminirouter/qa-m-${name}.png`,
    fullPage: false,
  });

  // Detect horizontal overflow — the most common mobile layout bug.
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  const hasOverflow = overflow.scrollW > overflow.clientW + 2;
  console.log(
    `${name.padEnd(8)} scrollW=${overflow.scrollW} clientW=${overflow.clientW} overflow=${hasOverflow}`,
  );
}

console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();

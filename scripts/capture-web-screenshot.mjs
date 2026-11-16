import { chromium } from './lib/playwright.mjs';

const browser = await chromium.launch({
  channel: 'msedge', // Installed by default on Windows 11
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const screenshotPath = 'D:/projectradom/geminirouter/screenshot-dark-accounts.png';
await page.screenshot({ path: screenshotPath, fullPage: true });

console.log('Saved screenshot to:', screenshotPath);
await browser.close();

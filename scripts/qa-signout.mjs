import { chromium } from './lib/playwright.mjs';

const BASE = 'http://127.0.0.1:3000';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. Open the dashboard.
await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
console.log('1. at /app, url =', page.url());
const onDashboard = await page.evaluate(() =>
  document.body.innerText.includes('Everything, at a glance.'),
);
console.log('   dashboard rendered:', onDashboard);

// 2. Click Sign out.
const signOut = page.locator('button', { hasText: 'Sign out' }).first();
console.log('   sign out button visible:', await signOut.isVisible());
await signOut.click();
await page.waitForTimeout(2000);

const urlAfter = page.url();
const textAfter = await page.evaluate(() => document.body.innerText);
console.log('2. after sign out, url =', urlAfter);
console.log('   dashboard gone:', !textAfter.includes('Everything, at a glance.'));
console.log('   on login page:', textAfter.includes('Sign in'));
await page.screenshot({ path: 'D:/projectradom/geminirouter/qa-signout.png', fullPage: true });

// 3. Navigating back to /app must NOT let us in.
await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const urlRetry = page.url();
const textRetry = await page.evaluate(() => document.body.innerText);
console.log('3. revisit /app -> url =', urlRetry);
console.log('   blocked (still login):', !textRetry.includes('Everything, at a glance.'));

// 4. Sign back in from open mode.
const continueBtn = page.locator('button[type=submit]').first();
if (await continueBtn.count()) {
  await continueBtn.click();
  await page.waitForTimeout(2500);
  console.log('4. after Continue, url =', page.url());
  const back = await page.evaluate(() => document.body.innerText.includes('Everything, at a glance.'));
  console.log('   dashboard back:', back);
}

console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();

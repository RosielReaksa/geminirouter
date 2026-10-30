import { chromium } from './lib/playwright.mjs';

const BASE = 'http://127.0.0.1:3999';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. /app with no session must land on the login page.
await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('after /app, url =', page.url());
await page.screenshot({ path: 'D:/projectradom/geminirouter/qa-login-real.png', fullPage: true });

const hasPasswordField = await page.locator('#password').count();
console.log('password field present:', hasPasswordField > 0);

// 2. Wrong password shows an error.
if (hasPasswordField > 0) {
  await page.fill('#password', 'definitely-wrong');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('shows error for wrong password:', /incorrect/i.test(bodyText));

  // 3. Correct password enters the dashboard.
  await page.fill('#password', 'testpass123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(2500);
  console.log('after correct password, url =', page.url());
  const dash = await page.evaluate(() => document.body.innerText.includes('Everything, at a glance.'));
  console.log('dashboard rendered:', dash);
  await page.screenshot({ path: 'D:/projectradom/geminirouter/qa-dash-authed.png', fullPage: true });
}

console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();

/**
 * Browser smoke test for the UI changes on this branch.
 *
 * Checks, against a running bridge:
 *  - the marketing pages render (footer year, legal "last updated", models page)
 *  - client-side navigation works (Links still behave as links)
 *  - no React error boundary / console errors on the pages that were refactored
 *
 * Usage: node scripts/qa-ui-fixes.mjs http://127.0.0.1:3099
 */
import { chromium } from './lib/playwright.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:3099').replace(/\/$/, '');
const failures = [];

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const visit = async (path, settle = 400) => {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(settle);
  return page.url();
};

// --- Marketing pages -------------------------------------------------------
await visit('/');
check('landing renders', (await page.locator('body').innerText()).length > 200);

const footer = await page.locator('footer').first().innerText();
check('footer renders a copyright year', /©\s*\d{4}\s+geminirouter/.test(footer), footer.slice(0, 120));

// Client-side nav: click a footer/nav link and confirm no full reload happened.
await page.evaluate(() => { window.__spaMarker = 'kept'; });
await page.locator('a[href="/models"]').first().click();
await page.waitForTimeout(600);
check('link navigation is client-side', (await page.evaluate(() => window.__spaMarker)) === 'kept', page.url());
check('models page reached', page.url().endsWith('/models'));

await visit('/privacy');
const legal = await page.locator('body').innerText();
check('legal page shows an updated date', /Last updated\s+[A-Z][a-z]+ \d{1,2}, \d{4}/.test(legal), legal.slice(0, 200));

await visit('/docs');
check('docs page renders media section', /audio|media/i.test(await page.locator('body').innerText()));

for (const path of ['/pricing', '/terms', '/how-it-works']) {
  const url = await visit(path);
  check(`${path} loads`, url.endsWith(path), url);
}

// With no GEMINIROUTER_ADMIN_PASSWORD (open mode) the server reports an active
// session, so /login correctly redirects to /app. Assert the redirect instead of
// assuming the login form stays put.
const loginUrl = await visit('/login');
check(
  '/login renders or redirects to the dashboard',
  loginUrl.endsWith('/login') || loginUrl.endsWith('/app'),
  loginUrl,
);

check('no console errors on marketing pages', consoleErrors.length === 0, consoleErrors.join(' | '));

// --- Dashboard -------------------------------------------------------------
const dashErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') dashErrors.push(msg.text());
});

await visit('/app', 1500);
const appText = await page.locator('body').innerText();
check('dashboard renders without a crash', !/Something went wrong|Unexpected Application Error/i.test(appText));

// Visit each dashboard tab so every refactored component mounts.
for (const tab of ['accounts', 'models', 'playground', 'gateway', 'traffic', 'usage', 'gemini', 'settings']) {
  await visit(`/app/${tab}`, 1200);
  const text = await page.locator('body').innerText();
  const crashed = /Something went wrong|Cannot read properties|Unexpected Application Error/i.test(text);
  check(`dashboard ${tab} tab mounts`, !crashed, text.slice(0, 160));
}

check(
  'no React crash console errors on dashboard tabs',
  !dashErrors.some((e) => /Maximum update depth|too many re-renders|Cannot update a component/i.test(e)),
  dashErrors.join(' | '),
);

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');

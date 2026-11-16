/**
 * Production smoke test for the deployed build (public surface only).
 * The dashboard requires a password, so it is not exercised here.
 */
import { chromium } from './lib/playwright.mjs';

const base = (process.argv[2] || 'https://framecall.site').replace(/\/$/, '');
const failures = [];
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

for (const path of ['/', '/models', '/docs', '/pricing', '/privacy', '/terms', '/how-it-works']) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
  const body = await page.locator('body').innerText();
  check(`${path} renders content`, body.length > 150, `${body.length} chars`);
}

// The docs page must state the new 1-hour ceiling.
await page.goto(`${base}/docs`, { waitUntil: 'networkidle' });
const docs = await page.locator('body').innerText();
check('docs state the 1-hour media ceiling', /to 1 hour are accepted/i.test(docs));
check('docs no longer claim 5 hours', !/to 5 hours are accepted/i.test(docs));

// Footer year and client-side nav still work on the new bundle.
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
const footer = await page.locator('footer').first().innerText();
check('footer shows a copyright year', /©\s*\d{4}\s+geminirouter/.test(footer), footer.slice(0, 80));

await page.evaluate(() => { window.__spa = 'kept'; });
await page.locator('a[href="/models"]').first().click();
await page.waitForTimeout(700);
check('client-side navigation intact', (await page.evaluate(() => window.__spa)) === 'kept', page.url());

// /app must redirect to /login when a dashboard password is configured.
// /api/auth/session returns 401 by design for a signed-out visitor, so that
// console entry is expected and filtered out.
const expected401 = (t) => /status of 401/.test(t);
await page.goto(`${base}/app`, { waitUntil: 'networkidle' });
const appUrl = page.url();
check('/app requires sign-in', appUrl.endsWith('/login') || /sign in/i.test(await page.locator('body').innerText()), appUrl);

const unexpected = errors.filter((e) => !expected401(e));
check('no page errors on public pages', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nProduction public surface OK.');

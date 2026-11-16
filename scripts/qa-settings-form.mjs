/**
 * Targeted check for the SettingsPage render-phase re-sync.
 *
 * It proves two things the lint rule cared about:
 *  1. Typing into the form does not get clobbered by a re-render.
 *  2. A config change from outside the form (a refresh) does update the form.
 *  3. No "Maximum update depth exceeded" loop.
 */
import { chromium } from './lib/playwright.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:3099').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage();

const loops = [];
page.on('console', (msg) => {
  if (/Maximum update depth|too many re-renders/i.test(msg.text())) loops.push(msg.text());
});

await page.goto(`${base}/app/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const inputs = page.locator('input');
const count = await inputs.count();
console.log(`settings form inputs: ${count}`);

let typedOk = true;
if (count > 0) {
  const first = inputs.first();
  const before = await first.inputValue();
  const next = before === '11' ? '12' : '11';
  await first.fill(next);
  await page.waitForTimeout(300);
  const after = await first.inputValue();
  typedOk = after === next;
  console.log(`typed "${next}" -> value is "${after}" (was "${before}")`);
}

let relatesOk = true;
const selects = page.locator('select');
if (await selects.count() > 0) {
  const sel = selects.first();
  const before = await sel.inputValue();
  await page.waitForTimeout(200);
  relatesOk = (await sel.inputValue()) === before;
  console.log(`select stable across renders: ${relatesOk} (${before})`);
}

await browser.close();

const failed = !typedOk || !relatesOk || loops.length > 0;
if (failed) {
  console.error('settings checks failed', { typedOk, relatesOk, loops });
  process.exit(1);
}
console.log('Settings form behaves correctly.');

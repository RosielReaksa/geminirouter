import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidates = [
  process.env.PLAYWRIGHT_MODULE_PATH,
  'playwright',
  path.resolve(process.cwd(), 'node_modules/playwright/index.mjs'),
  path.resolve(process.cwd(), '../node_modules/playwright/index.mjs'),
  path.resolve(process.cwd(), 'frontend/node_modules/playwright/index.mjs'),
].filter(Boolean);

let chromium;
let lastError;

for (const candidate of candidates) {
  if (chromium) break;
  const specifier = path.isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
  try {
    const mod = await import(specifier);
    chromium = mod.chromium ?? mod.default?.chromium;
  } catch (error) {
    lastError = error;
  }
}

if (!chromium) {
  throw new Error(
    `Playwright could not be loaded. Install it with "npm i -D playwright" or set PLAYWRIGHT_MODULE_PATH to playwright/index.mjs.${
      lastError ? ` Last error: ${lastError.message}` : ''
    }`,
  );
}

export { chromium };

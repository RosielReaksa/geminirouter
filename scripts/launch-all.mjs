import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CORE_REPO = path.resolve(process.env.CORE_HOME || path.join(REPO_ROOT, 'core'));
const PROFILE_DIR = path.resolve(process.env.CORE_PROFILE_DIR || path.join(REPO_ROOT, 'core-profile'));
const API_KEY_PATH = path.join(PROFILE_DIR, 'API_KEY.txt');

if (!fs.existsSync(path.join(CORE_REPO, 'dist', 'core', 'main.cjs'))) {
  console.error(`[ERROR] Core bundle not found at ${path.join(CORE_REPO, 'dist', 'core', 'main.cjs')}.`);
  console.error('Install the AntigravityManager core and set CORE_HOME to its directory.');
  process.exit(1);
}

if (!fs.existsSync(API_KEY_PATH)) {
  console.error(`[ERROR] API key file not found at ${API_KEY_PATH}.`);
  process.exit(1);
}

const API_KEY = fs.readFileSync(API_KEY_PATH, 'utf8').trim();

const cleanEnv = { ...process.env };
delete cleanEnv.ANTIGRAVITY_OAUTH_CLIENTS;
delete cleanEnv.ANTIGRAVITY_OAUTH_CLIENT_KEY;

console.log('[1/2] Spawning standalone core (port 8046)...');
const core = spawn(process.execPath, ['dist/core/main.cjs'], {
  cwd: CORE_REPO,
  detached: true,
  stdio: 'inherit',
  env: {
    ...cleanEnv,
    USERPROFILE: PROFILE_DIR,
    HOME: PROFILE_DIR,
  },
});
core.unref();

await new Promise((r) => setTimeout(r, 6000));

console.log('[2/2] Spawning bridge server (port 3000)...');
const bridge = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.join(REPO_ROOT, 'server'),
  detached: true,
  stdio: 'inherit',
  env: {
    ...cleanEnv,
    PORT: '3000',
    HOST: '0.0.0.0',
    USERPROFILE: PROFILE_DIR,
    HOME: PROFILE_DIR,
    GEMINIROUTER_GATEWAY_PORT: '8046',
    GEMINIROUTER_GATEWAY_API_KEY: API_KEY,
    CORE_HOME: CORE_REPO,
  },
});
bridge.unref();

console.log('Both processes spawned successfully.');
console.log(`Core PID: ${core.pid}, Bridge PID: ${bridge.pid}`);
process.exit(0);

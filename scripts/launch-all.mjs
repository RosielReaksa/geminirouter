import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CORE_REPO = path.resolve('D:/projectradom/AntigravityManager');
const PROFILE_DIR = path.resolve('D:/projectradom/geminirouter/core-profile');
const API_KEY = fs.readFileSync(path.join(PROFILE_DIR, 'API_KEY.txt'), 'utf8').trim();

const cleanEnv = { ...process.env };
delete cleanEnv.ANTIGRAVITY_OAUTH_CLIENTS;
delete cleanEnv.ANTIGRAVITY_OAUTH_CLIENT_KEY;

// 1. Start core
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

// Wait 6 seconds for core to open pipes
await new Promise((r) => setTimeout(r, 6000));

// 2. Start bridge server
console.log('[2/2] Spawning bridge server (port 3000)...');
const bridge = spawn(process.execPath, ['dist/index.js'], {
  cwd: 'D:/projectradom/geminirouter/server',
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
  },
});
bridge.unref();

console.log('Both processes spawned successfully.');
console.log(`Core PID: ${core.pid}, Bridge PID: ${bridge.pid}`);
process.exit(0);

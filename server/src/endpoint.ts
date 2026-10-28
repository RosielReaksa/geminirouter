import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';

export function getAgentDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.antigravity-agent');
}

export function getLocalCoreEndpoint(): string {
  // 1. Explicit env override
  if (process.env.ANTIGRAVITY_CORE_PIPE) {
    return process.env.ANTIGRAVITY_CORE_PIPE;
  }

  if (process.platform === 'win32') {
    // 2. Auto-discover active non-desktop core pipes if available
    try {
      const desktopPipeSuffix = '2a014b31fabdb803';
      const pipes = fs.readdirSync('//./pipe/').filter((p) =>
        p.toLowerCase().startsWith('antigravity-manager-core-v1-')
      );

      // Prefer isolated/parallel core pipe over the installed desktop app pipe
      const isolatedPipe = pipes.find((p) => !p.includes(desktopPipeSuffix));
      if (isolatedPipe) {
        return `\\\\.\\pipe\\${isolatedPipe}`;
      }
    } catch {
      // fallback
    }

    // 3. Fallback to hash of home directory
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const userScope = crypto
      .createHash('sha256')
      .update(home.toLowerCase())
      .digest('hex')
      .slice(0, 16);
    return `\\\\.\\pipe\\antigravity-manager-core-v1-${userScope}`;
  }

  return path.join(getAgentDir(), 'runtime', 'core-v1.sock');
}

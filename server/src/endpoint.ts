import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function getAgentDir(): string {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.antigravity-agent');
  }
  return path.join(os.homedir(), '.antigravity-agent');
}

export function getLocalCoreEndpoint(): string {
  if (process.platform === 'win32') {
    const userScope = crypto
      .createHash('sha256')
      .update(os.homedir().toLowerCase())
      .digest('hex')
      .slice(0, 16);
    return `\\\\.\\pipe\\antigravity-manager-core-v1-${userScope}`;
  }
  return path.join(getAgentDir(), 'runtime', 'core-v1.sock');
}

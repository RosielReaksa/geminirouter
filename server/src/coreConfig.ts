import fs from 'node:fs';
import path from 'node:path';
import type { CoreProxyConfig } from './pool-state.js';

/**
 * Reads and (carefully) writes the `proxy` section of the AntigravityManager
 * profile config at ~/.antigravity-agent/gui_config.json — the same file the
 * core reads its scheduling settings from. The API key lives in this file too;
 * it is never logged and never returned to the browser.
 */

export function coreGuiConfigPath(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(homeDir, '.antigravity-agent', 'gui_config.json');
}

export function readCoreProxyConfig(): CoreProxyConfig | null {
  try {
    const filePath = coreGuiConfigPath();
    if (!fs.existsSync(filePath)) return null;
    const gui = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!gui || typeof gui !== 'object' || !gui.proxy) return null;
    const proxy = { ...gui.proxy } as CoreProxyConfig;
    // Never let the key leak through this reader's callers.
    delete proxy.api_key;
    return proxy;
  } catch {
    return null;
  }
}

export interface ApplyResult {
  appliedToFile: boolean;
  filePath: string;
  note: string;
}

/**
 * Merge a patch into the proxy section of gui_config.json. The file write is
 * atomic (tmp + rename). If a desktop app or standalone core is running it may
 * hold its own in-memory copy and rewrite the file on exit, so live updates
 * should also be applied through the core RPC when it is reachable — the
 * caller owns that decision and reports both paths honestly.
 */
export function applyCoreProxyConfig(patch: CoreProxyConfig): ApplyResult {
  const filePath = coreGuiConfigPath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        appliedToFile: false,
        filePath,
        note: `Core profile config not found at ${filePath}; start the core once to create it.`,
      };
    }

    const gui = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!gui || typeof gui !== 'object') {
      return { appliedToFile: false, filePath, note: 'Core profile config is not valid JSON.' };
    }

    const sanitized: CoreProxyConfig = { ...patch };
    delete sanitized.api_key; // the bridge never writes credentials

    gui.proxy = { ...(gui.proxy || {}), ...sanitized };

    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(gui, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);

    return {
      appliedToFile: true,
      filePath,
      note:
        'Written to the core profile config. A running core may need a restart (or an RPC apply) to pick it up.',
    };
  } catch (err: any) {
    return {
      appliedToFile: false,
      filePath,
      note: `Failed to write core config: ${err?.message || String(err)}`,
    };
  }
}

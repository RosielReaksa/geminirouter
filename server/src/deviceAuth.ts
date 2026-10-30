import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Device pairing for the desktop helper.
 *
 * The dashboard mints a short-lived 6-digit code. The helper exchanges it for a
 * long random bearer token that is scoped (by the auth middleware) to a narrow
 * set of routes. Only the SHA-256 hash of the token is persisted, so a stolen
 * devices.json cannot be replayed against the API.
 */

export interface DeviceRecord {
  id: string;
  label: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface PairingCode {
  code: string;
  expiresAt: number;
  attempts: number;
}

const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_CODE_MAX_ATTEMPTS = 5;
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_WINDOW_MAX = 20;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export class DeviceTokenStore {
  private activeCode: PairingCode | null = null;
  private devices: DeviceRecord[] = [];
  private pairAttempts: number[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { devices?: DeviceRecord[] };
      this.devices = Array.isArray(raw.devices) ? raw.devices : [];
    } catch {
      this.devices = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }

  createPairingCode(): { code: string; expiresAt: number } {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    this.activeCode = { code, expiresAt, attempts: 0 };
    return { code, expiresAt };
  }

  private withinPairRateLimit(): boolean {
    const now = Date.now();
    this.pairAttempts = this.pairAttempts.filter((t) => now - t < PAIR_WINDOW_MS);
    if (this.pairAttempts.length >= PAIR_WINDOW_MAX) return false;
    this.pairAttempts.push(now);
    return true;
  }

  pair(input: string, label: string): { token: string; device: DeviceRecord } | null {
    if (!this.withinPairRateLimit()) return null;
    const active = this.activeCode;
    if (!active) return null;
    if (active.expiresAt <= Date.now()) {
      this.activeCode = null;
      return null;
    }
    if (!constantTimeEqual(input, active.code)) {
      active.attempts += 1;
      if (active.attempts >= PAIR_CODE_MAX_ATTEMPTS) this.activeCode = null;
      return null;
    }

    this.activeCode = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const device: DeviceRecord = {
      id: crypto.randomUUID(),
      label: label.trim().slice(0, 80) || 'Desktop helper',
      hash: hashToken(token),
      createdAt: Date.now(),
    };
    this.devices.push(device);
    this.save();
    return { token, device };
  }

  verify(token: string): boolean {
    if (!token) return false;
    const hash = hashToken(token);
    const device = this.devices.find((entry) => constantTimeEqual(entry.hash, hash));
    if (!device) return false;
    const now = Date.now();
    if (!device.lastUsedAt || now - device.lastUsedAt > 60_000) {
      device.lastUsedAt = now;
      this.save();
    }
    return true;
  }

  list(): Array<Omit<DeviceRecord, 'hash'>> {
    return this.devices.map(({ hash: _hash, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== id);
    if (this.devices.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}

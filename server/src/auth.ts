import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Session tokens for the dashboard.
 *
 * The admin password is never stored in the browser. The login form exchanges
 * it once for a random token held in server memory with an expiry; the client
 * keeps only that token. Restarting the bridge invalidates every session, which
 * is the safe default for a single-user private gateway.
 */
interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(): Session {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: Session = { token, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    this.sessions.set(token, session);
    this.prune();
    return session;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

/** Constant-time comparison that does not leak length via an early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Burn a comparison so timing does not reveal the length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractCredential(request: FastifyRequest): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header === 'string') {
    const parts = header.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1];
    }
  }
  const custom = request.headers['x-admin-password'];
  return typeof custom === 'string' ? custom : undefined;
}

/**
 * Routes reachable without a session. Deliberately narrow: public aggregates
 * and model ids only — never account identities, quota detail or traffic.
 */
const PUBLIC_EXACT = new Set([
  '/',
  '/index.html',
  '/favicon.ico',
  '/robots.txt',
  '/api/public/stats',
  '/api/public/models',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/health',
  '/api/device/pair',
  '/oauth/callback',
]);

const PUBLIC_PREFIXES = ['/assets/', '/v1/'];

/** Public marketing pages — served as the SPA shell without auth. */
const PUBLIC_PAGE_PREFIXES = ['/pricing', '/models', '/docs', '/privacy', '/terms', '/login'];

export function isPublicRoute(url: string): boolean {
  const path = url.split('?')[0];
  if (PUBLIC_EXACT.has(path)) return true;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (PUBLIC_PAGE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return true;
  return false;
}

export interface DeviceVerifier {
  verify(token: string): boolean;
}

export function createAuthMiddleware(
  adminPassword: string | undefined,
  sessions: SessionStore,
  devices?: DeviceVerifier,
  deviceRoutes: ReadonlySet<string> = new Set(),
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];

    // No password configured: the gateway is open (local/dev only).
    if (!adminPassword || adminPassword.trim() === '') {
      return;
    }

    if (isPublicRoute(request.url)) {
      return;
    }

    // Any non-API path is the SPA shell; the client routes to login if needed.
    if (!path.startsWith('/api') && !path.startsWith('/v1')) {
      return;
    }

    const credential = extractCredential(request);
    if (!credential) {
      return reply.code(401).send({
        ok: false,
        error: 'Unauthorized',
        message: 'Sign in to access the dashboard.',
      });
    }

    // Paired desktop helpers get a narrow, route-scoped bearer token.
    if (devices && deviceRoutes.has(path) && devices.verify(credential)) {
      return;
    }

    if (sessions.isValid(credential)) {
      return;
    }

    // Allow the raw admin password too (scripts, curl), compared in constant time.
    if (safeEqual(credential, adminPassword)) {
      return;
    }

    return reply.code(401).send({
      ok: false,
      error: 'Unauthorized',
      message: 'Session expired or invalid. Please sign in again.',
    });
  };
}

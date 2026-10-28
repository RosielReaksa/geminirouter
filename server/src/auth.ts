import type { FastifyRequest, FastifyReply } from 'fastify';

export function createAuthMiddleware(adminPassword?: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // If no admin password is set in env, allow access
    if (!adminPassword || adminPassword.trim() === '') {
      return;
    }

    // Allow static frontend assets, favicon, etc.
    const url = request.url;
    if (
      url === '/' ||
      url === '/index.html' ||
      url.startsWith('/assets/') ||
      url.startsWith('/v1/') || // v1 API key authentication handled by gateway proxy
      url === '/api/status' // Allow health status check
    ) {
      return;
    }

    // Check Authorization header or Cookie or X-Admin-Password
    const authHeader = request.headers['authorization'];
    const customHeader = request.headers['x-admin-password'];

    if (customHeader === adminPassword) {
      return;
    }

    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && (parts[0] === 'Bearer' || parts[0] === 'Basic')) {
        const token = parts[1];
        if (token === adminPassword) {
          return;
        }
        // Also support Basic auth decodings
        if (parts[0] === 'Basic') {
          const decoded = Buffer.from(token, 'base64').toString('utf8');
          const [user, pass] = decoded.split(':');
          if (pass === adminPassword || user === adminPassword) {
            return;
          }
        }
      }
    }

    // Deny unauthorized access
    return reply.code(401).send({
      ok: false,
      error: 'Unauthorized',
      message: 'Dashboard requires GEMINIROUTER_ADMIN_PASSWORD authentication',
    });
  };
}

/**
 * Dashboard authentication.
 *
 * The admin password is exchanged once for a server-held session token. Only
 * the token is kept in localStorage; the password itself is never persisted.
 */

const TOKEN_KEY = 'geminirouter_session_token';
/**
 * Set when the user explicitly signs out. Needed because a gateway with no
 * admin password configured reports every request as authenticated — without
 * this flag, signing out would bounce straight back into the dashboard.
 */
const SIGNED_OUT_KEY = 'geminirouter_signed_out';

export interface LoginResult {
  ok: boolean;
  error?: string;
  open?: boolean;
}

export const authApi = {
  getToken(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },

  setToken(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable */
    }
  },

  clearToken(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },

  /** True when the user deliberately signed out in this browser. */
  isSignedOut(): boolean {
    try {
      return sessionStorage.getItem(SIGNED_OUT_KEY) === '1';
    } catch {
      return false;
    }
  },

  clearSignedOut(): void {
    try {
      sessionStorage.removeItem(SIGNED_OUT_KEY);
    } catch {
      /* ignore */
    }
  },

  markSignedOut(): void {
    try {
      sessionStorage.setItem(SIGNED_OUT_KEY, '1');
    } catch {
      /* ignore */
    }
  },

  /** Authorization headers for dashboard API calls. */
  headers(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  async login(password: string): Promise<LoginResult> {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error || 'Incorrect password.' };
      }
      if (data?.token) this.setToken(data.token);
      // A successful sign-in cancels any earlier sign-out.
      this.clearSignedOut();
      return { ok: true, open: Boolean(data?.open) };
    } catch {
      return { ok: false, error: 'Could not reach the gateway.' };
    }
  },

  /** Returns true when the stored token is still accepted. */
  async check(): Promise<{ authenticated: boolean; requiresPassword: boolean }> {
    // An explicit sign-out wins over the server's answer. In open mode (no
    // admin password) the server always reports authenticated, so without this
    // the dashboard would reopen immediately after signing out.
    if (this.isSignedOut()) {
      return { authenticated: false, requiresPassword: true };
    }
    try {
      const res = await fetch('/api/auth/session', { headers: this.headers() });
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        return { authenticated: false, requiresPassword: data?.requiresPassword !== false };
      }
      const data = await res.json().catch(() => ({}));
      return { authenticated: Boolean(data?.authenticated), requiresPassword: false };
    } catch {
      return { authenticated: false, requiresPassword: true };
    }
  },

  async logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: this.headers() });
    } catch {
      /* ignore */
    }
    this.clearToken();
    this.markSignedOut();
  },
};

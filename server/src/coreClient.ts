import axios, { type AxiosRequestConfig } from 'axios';
import { getLocalCoreEndpoint } from './endpoint.js';

export interface CoreStatusResponse {
  version?: number;
  ok?: boolean;
  status?: {
    state: 'stopped' | 'starting' | 'running' | 'stopping';
    pid: number;
    gateway: {
      running: boolean;
      port: number | null;
    };
  };
}

export interface CoreHandshakeResponse {
  version: number;
  compatibility: number;
  kind: string;
  pid: number;
  epoch: string;
  profile: string;
  ready: boolean;
}

export class CoreClient {
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || getLocalCoreEndpoint();
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  private async rawRequest<T>(config: AxiosRequestConfig): Promise<T> {
    const isWindows = process.platform === 'win32';
    const socketPath = this.endpoint;

    // Axios on Windows named pipes or Unix domain sockets
    const response = await axios.request<T>({
      adapter: 'http',
      socketPath,
      baseURL: 'http://localhost',
      httpAgent: false,
      timeout: 4000,
      maxRedirects: 0,
      proxy: false,
      ...config,
      headers: {
        Accept: 'application/json',
        ...(config.headers || {}),
      },
    });

    return response.data;
  }

  /**
   * Like rawRequest but never throws: returns status + parsed body so
   * callers (OAuth flows) can surface the core's real error reasons
   * (e.g. 409 login-active) instead of swallowing them.
   */
  private async rawRequestSafe<T = any>(config: AxiosRequestConfig): Promise<{ status: number; data: T | any }> {
    try {
      const data = await this.rawRequest<T>(config);
      return { status: 200, data };
    } catch (err: any) {
      return {
        status: err?.response?.status ?? 0,
        data: err?.response?.data ?? { message: err?.code || err?.message || 'core unreachable' },
      };
    }
  }

  async isCoreAlive(): Promise<boolean> {
    try {
      const data = await this.rawRequest<CoreStatusResponse>({
        method: 'GET',
        url: '/v1/status',
      });
      return !!data && (data.ok === true || !!data.status);
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<CoreStatusResponse['status'] | null> {
    try {
      const res = await this.rawRequest<CoreStatusResponse>({
        method: 'GET',
        url: '/v1/status',
      });
      return res.status || null;
    } catch {
      return null;
    }
  }

  async handshake(): Promise<CoreHandshakeResponse | null> {
    try {
      return await this.rawRequest<CoreHandshakeResponse>({
        method: 'GET',
        url: '/v1/handshake',
      });
    } catch {
      return null;
    }
  }

  // OAuth endpoints provided by Core.
  // A dangling session (user closed the modal mid-login) otherwise blocks
  // every new start with 409 login-active until it times out, so the bridge
  // cancels its own previous session before starting a new one.
  private lastSessionId: string | null = null;

  async cancelOAuth(sessionId: string): Promise<boolean> {
    const res = await this.rawRequestSafe({
      method: 'POST',
      url: `/v1/oauth/cancel/${encodeURIComponent(sessionId)}`,
    });
    return res.status >= 200 && res.status < 300;
  }

  async startOAuth(
    oauthClientKey?: string,
  ): Promise<
    | { ok: true; sessionId: string; authorizationUrl: string }
    | { ok: false; status: number; error: string }
  > {
    if (this.lastSessionId) {
      await this.cancelOAuth(this.lastSessionId);
      this.lastSessionId = null;
    }

    const crypto = await import('node:crypto');
    const diagnosticId = crypto.randomUUID();
    const res = await this.rawRequestSafe({
      method: 'POST',
      url: '/v1/oauth/start',
      data: {
        diagnosticId,
        ...(oauthClientKey ? { oauthClientKey } : {}),
      },
    });

    if (res.status >= 200 && res.status < 300 && res.data?.sessionId && res.data?.authorizationUrl) {
      this.lastSessionId = res.data.sessionId as string;
      return {
        ok: true,
        sessionId: res.data.sessionId,
        authorizationUrl: res.data.authorizationUrl,
      };
    }

    const detail =
      res.data?.message || res.data?.error?.message || res.data?.error || `core returned ${res.status || 'no response'}`;
    return {
      ok: false,
      status: res.status || 502,
      error: typeof detail === 'string' ? detail : JSON.stringify(detail),
    };
  }

  async getOAuthStatus(sessionId: string): Promise<any> {
    try {
      const res = await this.rawRequest<any>({
        method: 'GET',
        url: `/v1/oauth/status/${encodeURIComponent(sessionId)}`,
      });
      return res.status || null;
    } catch {
      return null;
    }
  }

  async completeOAuth(sessionId: string, code: string): Promise<boolean> {
    try {
      const res = await this.rawRequest<any>({
        method: 'POST',
        url: `/v1/oauth/complete/${encodeURIComponent(sessionId)}`,
        data: { code },
      });
      return !!res && res.ok === true;
    } catch {
      return false;
    }
  }

  // RPC procedures on /rpc/*
  // The core's oRPC handler wraps payloads as { json: <value> }; unwrap it.
  async callRpc<T = any>(procedure: string, input?: any): Promise<T | null> {
    try {
      const cleanProc = procedure.startsWith('/') ? procedure.slice(1) : procedure;
      const res = await this.rawRequest<any>({
        method: 'POST',
        url: `/rpc/${cleanProc}`,
        data: input ?? {},
      });
      if (res && typeof res === 'object' && 'json' in res) {
        return res.json as T;
      }
      return res as T;
    } catch {
      return null;
    }
  }
}

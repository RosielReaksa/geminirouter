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

  // OAuth endpoints provided by Core
  async startOAuth(oauthClientKey?: string): Promise<{ sessionId: string; authorizationUrl: string } | null> {
    try {
      const crypto = await import('node:crypto');
      const diagnosticId = crypto.randomUUID();
      const res = await this.rawRequest<any>({
        method: 'POST',
        url: '/v1/oauth/start',
        data: {
          diagnosticId,
          ...(oauthClientKey ? { oauthClientKey } : {}),
        },
      });
      if (res && res.sessionId && res.authorizationUrl) {
        return {
          sessionId: res.sessionId,
          authorizationUrl: res.authorizationUrl,
        };
      }
      return null;
    } catch {
      return null;
    }
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
  async callRpc<T = any>(procedure: string, input?: any): Promise<T | null> {
    try {
      const cleanProc = procedure.startsWith('/') ? procedure.slice(1) : procedure;
      const res = await this.rawRequest<any>({
        method: 'POST',
        url: `/rpc/${cleanProc}`,
        data: input ?? {},
      });
      return res;
    } catch {
      return null;
    }
  }
}

import axios from 'axios';

export interface DirectEgress {
  ip: string;
  country: string | null;
}

/** Public-IP lookup for traffic that did not use a proxy. */
const LOOKUP_URL = process.env.EGRESS_LOOKUP_URL || 'https://ipinfo.io/json';
const CACHE_TTL_MS = 30 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 4000;

let cached: (DirectEgress & { at: number }) | null = null;
let inFlight: Promise<DirectEgress | null> | null = null;

/**
 * Public IP + country of the gateway host, cached for 30 minutes.
 *
 * Used to label traffic that went out directly (no proxy assigned). Never
 * throws: a blocked lookup simply leaves the fields unset in the UI.
 */
export async function getDirectEgressInfo(): Promise<DirectEgress | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ip: cached.ip, country: cached.country };
  }

  if (!inFlight) {
    inFlight = axios
      .get(LOOKUP_URL, {
        timeout: LOOKUP_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        validateStatus: (status) => status === 200,
      })
      .then((response) => {
        const ip = String(response.data?.ip ?? '').trim();
        if (!ip) return null;
        const rawCountry = String(response.data?.country ?? '').trim().toUpperCase();
        const country = rawCountry.length === 2 ? rawCountry : null;
        cached = { ip, country, at: Date.now() };
        return { ip, country };
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** Test hook: forget the cached host identity. */
export function resetDirectEgressCache(): void {
  cached = null;
  inFlight = null;
}
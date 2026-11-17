import type { TrafficRecord } from './store.js';

export interface EgressInfo {
  /** Public IP the request left from. */
  ip: string;
  /** ISO 3166-1 alpha-2 country, when known. */
  country: string | null;
  /** `proxy` when it left through the account's Webshare IP. */
  via: 'proxy' | 'direct';
}

/**
 * Attach egress identity to traffic records.
 *
 * The lookup is injected so a proxy assignment, a cached host lookup, or a
 * fixed value can be used without this module knowing where it came from.
 * Records the lookup cannot resolve are returned untouched.
 */
export function applyEgress(
  records: TrafficRecord[],
  lookup: (record: TrafficRecord) => EgressInfo | null,
): TrafficRecord[] {
  return records.map((record) => {
    // A record that already carries its own egress identity (e.g. a TTS call
    // that reports the exact Webshare proxy it used) must not be overwritten
    // with the gateway host or an account proxy.
    if (record.egressIp) return record;
    const egress = lookup(record);
    if (!egress) return record;
    return {
      ...record,
      egressIp: egress.ip,
      egressCountry: egress.country,
      egressVia: egress.via,
    };
  });
}
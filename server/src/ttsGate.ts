/**
 * Concurrency gate for the public TTS API.
 *
 * Reuses the media gate's FIFO admission control, but with its own limits so a
 * burst of TTS traffic can never starve transcription or dubbing (and the
 * reverse). Sized for the service's ~100 concurrent target.
 */

import { MediaGate, type MediaGateOptions } from './mediaGate.js';

function readOptions(): MediaGateOptions {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  return {
    limit: int('TTS_MAX_CONCURRENT', 100, 1, 400),
    queueLimit: int('TTS_QUEUE_LIMIT', 300, 1, 2_000),
    timeoutMs: int('TTS_QUEUE_TIMEOUT_MS', 60_000, 1_000, 10 * 60_000),
  };
}

let _gate: MediaGate | null = null;

export function getSharedTtsGate(): MediaGate {
  if (!_gate) _gate = new MediaGate(readOptions());
  return _gate;
}

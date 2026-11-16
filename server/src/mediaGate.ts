/**
 * Concurrency gate for media jobs.
 *
 * A dubbing request can fan out into many model calls. Without a gate, 100 or
 * 200 simultaneous uploads would all enter the shared model queue at once and
 * most would fail. The gate lets a bounded number of jobs run immediately and
 * queues the rest in arrival order until a slot frees up.
 */

export interface MediaGateResult {
  ok: boolean;
  waitMs: number;
  reason?: 'queue_full' | 'timeout';
}

interface Waiter {
  enqueuedAt: number;
  resolve: (result: MediaGateResult) => void;
  timer: NodeJS.Timeout;
}

export interface MediaGateOptions {
  limit: number;
  queueLimit: number;
  timeoutMs: number;
}

export function readMediaGateOptions(): MediaGateOptions {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  return {
    limit: int('MEDIA_MAX_CONCURRENT_JOBS', 50, 1, 500),
    queueLimit: int('MEDIA_QUEUE_LIMIT', 500, 1, 5000),
    timeoutMs: int('MEDIA_QUEUE_TIMEOUT_MS', 10 * 60 * 1000, 1_000, 60 * 60 * 1000),
  };
}

export class MediaGate {
  private active = 0;
  private queue: Waiter[] = [];

  constructor(private readonly options: MediaGateOptions) {}

  stats(): { active: number; queued: number; limit: number; queueLimit: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.options.limit,
      queueLimit: this.options.queueLimit,
    };
  }

  /**
   * Acquire a slot. Resolves immediately when a slot is free, otherwise waits
   * in FIFO order. Resolves `{ok:false}` when the queue is full or the caller
   * has waited longer than the configured timeout.
   */
  acquire(): Promise<MediaGateResult> {
    if (this.active < this.options.limit) {
      this.active += 1;
      return Promise.resolve({ ok: true, waitMs: 0 });
    }

    if (this.queue.length >= this.options.queueLimit) {
      return Promise.resolve({ ok: false, waitMs: 0, reason: 'queue_full' });
    }

    return new Promise<MediaGateResult>((resolve) => {
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          resolve({ ok: false, waitMs: Date.now() - waiter.enqueuedAt, reason: 'timeout' });
        }, this.options.timeoutMs),
      };
      waiter.timer.unref?.();
      this.queue.push(waiter);
    });
  }

  /** Release a slot and admit the next waiter, if any. */
  release(): void {
    this.active = Math.max(0, this.active - 1);

    const next = this.queue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    this.active += 1;
    next.resolve({ ok: true, waitMs: Date.now() - next.enqueuedAt });
  }
}

let _sharedGate: MediaGate | null = null;

export function getSharedMediaGate(): MediaGate {
  if (!_sharedGate) _sharedGate = new MediaGate(readMediaGateOptions());
  return _sharedGate;
}

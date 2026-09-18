import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readdirSync } from 'node:fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { redactForLog } from '../common/error.filter';
import { ACTIVITY_CONFIG, type ActivityConfig } from './activity-config';

/** Every event carries a monotonic seq (gap-free incremental pull) and a ts. */
export type ActivityKind =
  | 'request'
  | 'error'
  | 'session'
  | 'mint'
  | 'lease'
  | 'ratelimit'
  | 'rpc'
  | 'provision'
  | 'lifecycle'
  | 'fatal';

export interface ActivityEvent {
  readonly seq: number;
  readonly ts: number;
  readonly kind: ActivityKind;
  /** Redacted, length-capped scalar fields only; secrets never reach here. */
  readonly [field: string]: string | number | boolean | undefined;
}

export interface PerfSample {
  readonly ts: number;
  readonly loopLagMeanMs: number;
  readonly loopLagMaxMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly openFds: number | null;
}

export interface ActivityStats {
  readonly enabled: boolean;
  readonly eventsCaptured: number;
  readonly eventsDropped: number;
  readonly eventsHeld: number;
  readonly eventCap: number;
  readonly perfSamplesHeld: number;
  readonly perfCap: number;
  readonly lastSeq: number;
}

/**
 * In-process rolling activity log: a bounded event ring plus a perf-sample ring,
 * pulled over the admin tier for remote diagnosis without host access.
 *
 * A dependency-free leaf on purpose — every capture site (the error filter, the
 * request interceptor, the session registry) depends on THIS, so it must depend
 * on nothing that could form a cycle. The perf sampler therefore reads only
 * process-level gauges; live session/RPC counts are joined at pull time.
 *
 * Redaction happens at capture, never at read: the ring only ever holds
 * length-capped, relay-URL-scrubbed scalars, so even a crash dump of it cannot
 * spill a secret it never stored.
 */
@Injectable()
export class ActivityLog implements OnModuleInit, OnModuleDestroy {
  readonly #events: ActivityEvent[] = [];
  readonly #perf: PerfSample[] = [];
  #seq = 0;
  #captured = 0;
  #dropped = 0;
  #loop: IntervalHistogram | null = null;
  #sampler: NodeJS.Timeout | null = null;

  constructor(@Inject(ACTIVITY_CONFIG) private readonly config: ActivityConfig) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    // A process-lifetime histogram reset every interval yields a timestamped
    // lag series, unlike the cumulative gauge on /admin/diagnostics.
    this.#loop = monitorEventLoopDelay({ resolution: 20 });
    this.#loop.enable();
    this.#sampler = setInterval(() => this.sample(), this.config.perfIntervalMs);
    this.#sampler.unref();
  }

  onModuleDestroy(): void {
    if (this.#sampler) clearInterval(this.#sampler);
    this.#loop?.disable();
  }

  /** Append one event. Structured object in; serialization is deferred to read. */
  emit(kind: ActivityKind, fields: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    const event: Record<string, unknown> = { seq: (this.#seq += 1), ts: Date.now(), kind };
    for (const [key, raw] of Object.entries(fields)) {
      const value = this.clean(raw);
      if (value !== undefined) event[key] = value;
    }
    this.#events.push(event as unknown as ActivityEvent);
    this.#captured += 1;
    if (this.#events.length > this.config.eventCap) {
      this.#events.shift();
      this.#dropped += 1;
    }
  }

  /** Events with seq strictly greater than `sinceSeq`, oldest first, capped. */
  recent(opts: { limit?: number; sinceSeq?: number; kind?: ActivityKind } = {}): ActivityEvent[] {
    const sinceSeq = opts.sinceSeq ?? 0;
    const limit = clampLimit(opts.limit, this.config.eventCap);
    const out: ActivityEvent[] = [];
    for (const event of this.#events) {
      if (event.seq <= sinceSeq) continue;
      if (opts.kind !== undefined && event.kind !== opts.kind) continue;
      out.push(event);
    }
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  perfSamples(limit?: number): PerfSample[] {
    const capped = clampLimit(limit, this.config.perfCap);
    return this.#perf.length > capped ? this.#perf.slice(this.#perf.length - capped) : [...this.#perf];
  }

  stats(): ActivityStats {
    return {
      enabled: this.config.enabled,
      eventsCaptured: this.#captured,
      eventsDropped: this.#dropped,
      eventsHeld: this.#events.length,
      eventCap: this.config.eventCap,
      perfSamplesHeld: this.#perf.length,
      perfCap: this.config.perfCap,
      lastSeq: this.#seq,
    };
  }

  private sample(): void {
    const loop = this.#loop;
    if (!loop) return;
    const mem = process.memoryUsage();
    this.#perf.push({
      ts: Date.now(),
      loopLagMeanMs: msFromNanos(loop.mean),
      loopLagMaxMs: msFromNanos(loop.max),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      openFds: readFdCount(),
    });
    loop.reset();
    if (this.#perf.length > this.config.perfCap) this.#perf.shift();
  }

  /** Cap length and scrub relay URLs; drop anything not a plain scalar. */
  private clean(raw: unknown): string | number | boolean | undefined {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string') return undefined;
    const scrubbed = redactForLog(raw);
    return scrubbed.length > this.config.maxFieldLen
      ? scrubbed.slice(0, this.config.maxFieldLen)
      : scrubbed;
  }
}

function clampLimit(limit: number | undefined, cap: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return cap;
  return Math.min(Math.floor(limit), cap);
}

function msFromNanos(nanos: number): number {
  if (!Number.isFinite(nanos)) return 0;
  return Math.round((nanos / 1e6) * 100) / 100;
}

/** Open fd count from /proc; null off Linux (dev boxes), same source as diagnostics. */
function readFdCount(): number | null {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

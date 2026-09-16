import { Injectable } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { RpcBoundaryService, type RpcBoundaryDiagnostics } from '../session/rpc-boundary.service';
import { SessionRegistry, type SessionRegistryDiagnostics } from '../session/session.registry';

const CORE_VERSION = (require('wative-core/package.json') as { version?: unknown }).version;

export interface DiagnosticsSnapshot {
  readonly uptimeSec: number;
  readonly coreVersion: string;
  readonly process: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
    /** Open file descriptors and the soft limit (Linux only; null off /proc). */
    readonly openFds: number | null;
    readonly openFdLimit: number | null;
    readonly eventLoopLagMeanMs: number;
    readonly eventLoopLagMaxMs: number;
  };
  readonly sessions: SessionRegistryDiagnostics;
  readonly rpc: RpcBoundaryDiagnostics;
}

/**
 * A read-only operational snapshot for remote diagnosis over HTTP. Admin-tier
 * only — the gauges (FD/memory/session/RPC counts) are profiling information, so
 * this lives behind the super-admin key, never on the public health probe.
 *
 * Everything here is a cheap in-process read: no locks, no core calls, no I/O
 * beyond a single /proc read for the fd count.
 */
@Injectable()
export class DiagnosticsService {
  // Enabled once at construction; the histogram runs for the process lifetime so
  // `max` still captures a spike that happened between two polls.
  private readonly loop: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly rpcBoundary: RpcBoundaryService,
  ) {
    this.loop.enable();
  }

  snapshot(): DiagnosticsSnapshot {
    const mem = process.memoryUsage();
    const fds = readFdStats();
    return {
      uptimeSec: Math.round(process.uptime()),
      coreVersion: typeof CORE_VERSION === 'string' ? CORE_VERSION : 'unknown',
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        openFds: fds.open,
        openFdLimit: fds.limit,
        eventLoopLagMeanMs: msFromNanos(this.loop.mean),
        eventLoopLagMaxMs: msFromNanos(this.loop.max),
      },
      sessions: this.sessions.diagnostics(),
      rpc: this.rpcBoundary.diagnostics(),
    };
  }
}

/** fd count + soft limit from /proc; null when /proc is absent (non-Linux dev). */
function readFdStats(): { open: number | null; limit: number | null } {
  try {
    const open = readdirSync('/proc/self/fd').length;
    const match = /Max open files\s+(\d+)/.exec(readFileSync('/proc/self/limits', 'utf8'));
    return { open, limit: match ? Number(match[1]) : null };
  } catch {
    return { open: null, limit: null };
  }
}

function msFromNanos(nanos: number): number {
  if (!Number.isFinite(nanos)) return 0;
  return Math.round((nanos / 1e6) * 100) / 100;
}

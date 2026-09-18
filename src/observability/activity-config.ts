import { resolve } from 'node:path';

/** Injection token + env parsing for the activity log's bounds. */
export const ACTIVITY_CONFIG = Symbol('tee-docker:activity-config');

export interface ActivityConfig {
  readonly enabled: boolean;
  readonly eventCap: number;
  readonly perfCap: number;
  readonly perfIntervalMs: number;
  readonly maxFieldLen: number;
  /** Persist the tail of the event ring to disk on shutdown/crash, reloaded at boot. */
  readonly crashDump: boolean;
  readonly crashDumpEvents: number;
  /** Absolute path in the writable state volume, next to state.json. */
  readonly crashDumpFile: string;
}

const DEFAULTS = {
  enabled: true,
  eventCap: 2000,
  perfCap: 900,
  perfIntervalMs: 1000,
  maxFieldLen: 256,
  crashDump: true,
  crashDumpEvents: 1000,
} as const;

/** Bounds are clamped, never trusted raw: an operator typo cannot unbound RAM. */
export function activityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ActivityConfig {
  // Same derivation as resolvePaths(), so the dump lands beside state.json
  // without ActivityLog needing to depend on the Paths provider.
  const stateDir = resolve(env.TEE_STATE_DIR ?? './state');
  return {
    enabled: env.TEE_ACTIVITY_LOG_ENABLED !== 'false',
    eventCap: intInRange(env.TEE_ACTIVITY_EVENT_CAP, DEFAULTS.eventCap, 100, 50_000),
    perfCap: intInRange(env.TEE_ACTIVITY_PERF_CAP, DEFAULTS.perfCap, 60, 20_000),
    perfIntervalMs: intInRange(env.TEE_ACTIVITY_PERF_INTERVAL_MS, DEFAULTS.perfIntervalMs, 250, 60_000),
    maxFieldLen: intInRange(env.TEE_ACTIVITY_MAX_FIELD_LEN, DEFAULTS.maxFieldLen, 32, 4096),
    crashDump: env.TEE_ACTIVITY_CRASH_DUMP !== 'false',
    crashDumpEvents: intInRange(env.TEE_ACTIVITY_CRASH_DUMP_EVENTS, DEFAULTS.crashDumpEvents, 50, 50_000),
    crashDumpFile: resolve(stateDir, 'activity-crash.json'),
  };
}

function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

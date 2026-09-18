/** Injection token + env parsing for the activity log's bounds. */
export const ACTIVITY_CONFIG = Symbol('tee-docker:activity-config');

export interface ActivityConfig {
  readonly enabled: boolean;
  readonly eventCap: number;
  readonly perfCap: number;
  readonly perfIntervalMs: number;
  readonly maxFieldLen: number;
}

const DEFAULTS: ActivityConfig = {
  enabled: true,
  eventCap: 2000,
  perfCap: 900,
  perfIntervalMs: 1000,
  maxFieldLen: 256,
};

/** Bounds are clamped, never trusted raw: an operator typo cannot unbound RAM. */
export function activityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ActivityConfig {
  return {
    enabled: env.TEE_ACTIVITY_LOG_ENABLED !== 'false',
    eventCap: intInRange(env.TEE_ACTIVITY_EVENT_CAP, DEFAULTS.eventCap, 100, 50_000),
    perfCap: intInRange(env.TEE_ACTIVITY_PERF_CAP, DEFAULTS.perfCap, 60, 20_000),
    perfIntervalMs: intInRange(env.TEE_ACTIVITY_PERF_INTERVAL_MS, DEFAULTS.perfIntervalMs, 250, 60_000),
    maxFieldLen: intInRange(env.TEE_ACTIVITY_MAX_FIELD_LEN, DEFAULTS.maxFieldLen, 32, 4096),
  };
}

function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

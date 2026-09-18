/** Injection token + env parsing for buffer mode's dials. */
export const BUFFER_CONFIG = Symbol('tee-docker:buffer-config');

export interface BufferConfig {
  /** True once BUFFER_SIZE > 0. Off means today's derive-on-demand behavior. */
  readonly enabled: boolean;
  /** Wallets derived per async replenish. */
  readonly batchSize: number;
  /** Replenish fires when the unallocated buffer drops below this. */
  readonly lowWatermark: number;
}

const MAX_BATCH = 500; // matches the per-call derive ceiling core is asked to honor

/** BUFFER_SIZE is clamped: an operator typo cannot ask core to derive unbounded. */
export function bufferConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BufferConfig {
  const raw = Number(env.BUFFER_SIZE);
  const size = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_BATCH) : 0;
  return {
    enabled: size > 0,
    batchSize: size,
    lowWatermark: Math.floor(size / 2),
  };
}

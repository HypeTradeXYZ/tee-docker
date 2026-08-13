import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Workspace, argon2BackendInfo } from 'wative-core';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';

const SAFE_NATIVE_BACKENDS = new Set(['node-rs']);
const DEFAULT_MAX_PROBE_MS = 1_000;
const MAX_PROBE_MS = 60_000;
const PositiveSafeInteger = z.coerce.number().int().positive().safe();

export const KDF_CHECK_CONFIG = Symbol('tee:kdf-check-config');
export const KDF_PROBE_RUNNER = Symbol('tee:kdf-probe-runner');

export interface KdfCheckConfig {
  readonly nodeEnv: string;
  readonly maxProbeMs: number;
  readonly allowUnsafe: boolean;
}

export interface KdfProbeObservation {
  readonly backends: readonly unknown[];
  readonly probeMs: number;
}

export type KdfProbeRunner = () => Promise<KdfProbeObservation>;

export interface KdfProbeIo {
  createTemp(): string;
  open(path: string, password: string): Promise<{ lock(): Promise<void> }>;
  backendInfo(): unknown;
  now(): number;
  remove(path: string): void;
}

export interface KdfStatus {
  readonly backends: readonly string[];
  readonly safe: boolean;
  readonly probeMs: number;
  readonly reason?: 'backend_unsafe' | 'probe_slow' | 'probe_failed';
}

export function kdfCheckConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KdfCheckConfig {
  if (env.TEE_SKIP_KDF_CHECK !== undefined) {
    throw new Error('TEE_SKIP_KDF_CHECK was removed; use TEE_ALLOW_UNSAFE_KDF=1 explicitly');
  }
  const parsed = PositiveSafeInteger.safeParse(
    env.TEE_KDF_MAX_PROBE_MS === undefined
      ? DEFAULT_MAX_PROBE_MS
      : env.TEE_KDF_MAX_PROBE_MS,
  );
  if (!parsed.success || parsed.data > MAX_PROBE_MS) {
    throw new Error(`TEE_KDF_MAX_PROBE_MS must be a positive safe integer at most ${MAX_PROBE_MS}`);
  }
  const unsafe = env.TEE_ALLOW_UNSAFE_KDF;
  if (unsafe !== undefined && unsafe !== '0' && unsafe !== '1') {
    throw new Error('TEE_ALLOW_UNSAFE_KDF must be exactly 0 or 1');
  }
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    maxProbeMs: parsed.data,
    allowUnsafe: unsafe === '1',
  };
}

/**
 * Run one real, fresh workspace derivation and report the backend selected by
 * wative-core. All cleanup is part of the probe: a handle or temporary-storage
 * cleanup failure is an unsafe boot result, never a warning-and-continue path.
 */
export function createKdfProbeRunner(io: KdfProbeIo): KdfProbeRunner {
  return async () => {
    const dir = io.createTemp();
    let workspace: { lock(): Promise<void> } | undefined;
    let observation: KdfProbeObservation | undefined;
    const failures: unknown[] = [];
    try {
      const started = io.now();
      workspace = await io.open(join(dir, 'probe'), 'kdf-probe-Passw0rd!');
      await workspace.lock();
      workspace = undefined;
      const info = io.backendInfo();
      if (!isBackendInfo(info)) throw new Error('KDF backend report is malformed');
      observation = {
        backends: info.overrides.length > 0 ? [...info.overrides] : [info.backend],
        probeMs: io.now() - started,
      };
    } catch (error) {
      failures.push(error);
    } finally {
      if (workspace) {
        try {
          await workspace.lock();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        io.remove(dir);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'KDF boot probe failed');
    return observation!;
  };
}

export const systemKdfProbeRunner = createKdfProbeRunner({
  createTemp: () => mkdtempSync(join(tmpdir(), 'tee-kdf-')),
  open: async (path, password) => Workspace.open({ path, password }),
  backendInfo: argon2BackendInfo,
  now: performance.now.bind(performance),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
});

function isBackendInfo(value: unknown): value is {
  readonly backend: string;
  readonly overrides: readonly string[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { backend?: unknown; overrides?: unknown };
  return typeof candidate.backend === 'string'
    && Array.isArray(candidate.overrides)
    && candidate.overrides.every((entry) => typeof entry === 'string');
}

export function assessKdfProbe(
  observation: KdfProbeObservation,
  maxProbeMs: number,
): KdfStatus {
  const backends = Array.isArray(observation.backends)
    && observation.backends.length > 0
    && observation.backends.every((backend): backend is string => typeof backend === 'string')
    ? [...observation.backends]
    : [];
  const backendSafe = backends.length > 0
    && backends.every((backend) => SAFE_NATIVE_BACKENDS.has(backend));
  const timeSafe = Number.isFinite(observation.probeMs)
    && observation.probeMs >= 0
    && observation.probeMs <= maxProbeMs;
  return {
    backends,
    safe: backendSafe && timeSafe,
    probeMs: observation.probeMs,
    reason: !backendSafe ? 'backend_unsafe' : !timeSafe ? 'probe_slow' : undefined,
  };
}

/** Refuse startup when the native KDF guarantee cannot be proven. */
@Injectable()
export class KdfCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KdfCheckService.name);
  #status: KdfStatus | null = null;

  constructor(
    @Inject(KDF_CHECK_CONFIG) private readonly config: KdfCheckConfig,
    @Inject(KDF_PROBE_RUNNER) private readonly runProbe: KdfProbeRunner,
  ) {}

  get status(): KdfStatus | null {
    return this.#status;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.nodeEnv === 'test') {
      this.logger.log('KDF boot probe skipped in test mode');
      return;
    }

    try {
      this.#status = assessKdfProbe(await this.runProbe(), this.config.maxProbeMs);
    } catch {
      this.#status = {
        backends: [],
        safe: false,
        probeMs: Number.NaN,
        reason: 'probe_failed',
      };
    }

    if (this.#status.safe) {
      this.logger.log(
        `native KDF backend verified (probe ${Math.ceil(this.#status.probeMs)}ms)`,
      );
      return;
    }

    const reason = this.#status.reason ?? 'probe_failed';
    if (this.config.allowUnsafe) {
      this.logger.warn(`UNSAFE KDF ACCEPTED BY OPERATOR (${reason})`);
      return;
    }
    this.logger.error(`KDF readiness check failed (${reason}); refusing startup`);
    throw new TeeError('TEE_KDF_BACKEND_UNSAFE', 'KDF readiness check failed', { reason });
  }
}

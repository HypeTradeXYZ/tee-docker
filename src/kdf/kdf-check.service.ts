import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Workspace, argon2BackendInfo } from 'wative-core';

/** Slowest-to-fastest. `noble` is the pure-JS path — seconds per derivation. */
const UNSAFE_BACKENDS = new Set(['noble']);

export interface KdfStatus {
  readonly backends: readonly string[];
  readonly safe: boolean;
  readonly probeMs: number;
}

/**
 * Which Argon2 implementation actually resolved.
 *
 * `@node-rs/argon2` is an OPTIONAL dependency of wative-core. A platform with
 * no prebuilt binary falls back silently, and the failure mode is a service
 * that is perfectly correct and orders of magnitude too slow — nothing else in
 * the stack would catch that. So we find out at boot, not in production.
 *
 * `argon2BackendInfo()` is a pure read that resolves nothing, so it honestly
 * answers "unresolved" until something has actually unlocked. Hence the
 * throwaway probe workspace.
 */
@Injectable()
export class KdfCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KdfCheckService.name);
  #status: KdfStatus | null = null;

  get status(): KdfStatus | null {
    return this.#status;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.TEE_SKIP_KDF_CHECK === '1') {
      this.logger.warn('KDF backend check skipped (TEE_SKIP_KDF_CHECK=1)');
      return;
    }
    this.#status = await this.probe();

    const { backends, safe, probeMs } = this.#status;
    const label = backends.join(', ') || 'unknown';

    if (!safe) {
      this.logger.error(
        `Argon2 backend is "${label}" — the pure-JS fallback. Expect seconds per unlock, ` +
          'not milliseconds. The optional native dependency @node-rs/argon2 has no prebuilt ' +
          'binary for this platform (musl/Alpine is the usual cause).',
      );
    } else {
      this.logger.log(`Argon2 backend: ${label} (probe ${probeMs}ms)`);
    }
  }

  /** Create and unlock a throwaway workspace, then report what resolved. */
  private async probe(): Promise<KdfStatus> {
    const dir = mkdtempSync(join(tmpdir(), 'tee-kdf-'));
    const started = Date.now();
    try {
      const password = 'kdf-probe-Passw0rd!';
      const ws = await Workspace.open({ path: join(dir, 'probe'), password });
      await ws.lock();

      const info = argon2BackendInfo();
      // A provider may carry its own backend, in which case the process-wide
      // default is never consulted and reads as "unresolved" — so overrides
      // are the authoritative answer when present.
      const backends =
        info.overrides.length > 0 ? [...info.overrides] : [info.backend];

      return {
        backends,
        safe: backends.length > 0 && !backends.some((b) => UNSAFE_BACKENDS.has(b)),
        probeMs: Date.now() - started,
      };
    } catch (err) {
      this.logger.error(`KDF probe failed: ${String(err)}`);
      return { backends: [], safe: false, probeMs: Date.now() - started };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ServiceStateSchema, type ServiceState, type TenantState } from './schemas';
import type { Paths } from './paths';

const EMPTY_TENANT: TenantState = { walletTotal: 0, workspaces: [] };

/**
 * Machine-owned mutable state — which workspaces exist and how many wallets
 * each holds. Never hand-edited.
 *
 * This exists because the wallet quota is per-apiKey across every workspace a
 * tenant owns, including workspaces that are locked at check time and
 * therefore unreadable. See DESIGN.md §4.
 *
 * Deliberately narrow: swapping JSON for SQLite should not touch callers.
 */
@Injectable()
export class ServiceStateService {
  #state: ServiceState;
  /** Serializes writes — concurrent mutations must not interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: Paths,
    initial: ServiceState,
  ) {
    this.#state = initial;
  }

  static fromFile(paths: Paths): ServiceStateService {
    let state: ServiceState = { tenants: {} };
    try {
      state = ServiceStateSchema.parse(JSON.parse(readFileSync(paths.stateFile, 'utf8')));
    } catch (err) {
      // A missing file is the normal first-boot case. Anything else means the
      // file exists but is unusable, and silently resetting it would erase the
      // quota ledger.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(`service state at ${paths.stateFile} is unreadable or invalid`, {
          cause: err,
        });
      }
    }
    return new ServiceStateService(paths, state);
  }

  tenant(tenantId: string): TenantState {
    return this.#state.tenants[tenantId] ?? EMPTY_TENANT;
  }

  /**
   * Apply a mutation and persist. Mutations are queued, so two concurrent
   * callers cannot both read-modify-write the same snapshot.
   */
  async mutate<T>(fn: (state: ServiceState) => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const draft: ServiceState = structuredClone(this.#state);
      const result = fn(draft);
      ServiceStateSchema.parse(draft);
      await this.#persist(draft);
      this.#state = draft;
      return result;
    });

    // Keep the chain alive even if this mutation rejects, or one failure
    // would wedge every subsequent write.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #persist(state: ServiceState): Promise<void> {
    mkdirSync(dirname(this.paths.stateFile), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous file intact
    // rather than a truncated ledger.
    const tmp = `${this.paths.stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.paths.stateFile);
  }
}

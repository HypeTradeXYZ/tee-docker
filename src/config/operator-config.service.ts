import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { TenantsConfigSchema, TtlSchema, type RawTenant, type Tenant } from './schemas';
import type { Paths } from './paths';
import { validateRecipient } from '../export/seal';

/**
 * The hand-edited operator config: who may call, and how much.
 *
 * Read-only. Loaded once at boot — a malformed or ambiguous file must stop the
 * process rather than start a wallet service in a half-understood state.
 */
@Injectable()
export class OperatorConfigService {
  readonly #byApiKey = new Map<string, Tenant>();
  readonly #byId = new Map<string, Tenant>();

  constructor(tenants: readonly Tenant[]) {
    for (const tenant of tenants) {
      this.#byApiKey.set(tenant.apiKey, tenant);
      this.#byId.set(tenant.id, tenant);
    }
  }

  static fromFile(paths: Paths): OperatorConfigService {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.tenantsFile, 'utf8'));
    } catch (cause) {
      throw new Error(`cannot read operator config at ${paths.tenantsFile}`, { cause });
    }

    const parsed = TenantsConfigSchema.parse(raw);
    return new OperatorConfigService(parsed.tenants.map(normalizeTenant));
  }

  byApiKey(apiKey: string): Tenant | null {
    return this.#byApiKey.get(apiKey) ?? null;
  }

  byId(id: string): Tenant | null {
    return this.#byId.get(id) ?? null;
  }

  get all(): readonly Tenant[] {
    return [...this.#byId.values()];
  }
}

/** Resolve every optional field once, so no caller has to know the defaults. */
function normalizeTenant(raw: RawTenant): Tenant {
  if (raw.exportPublicKey !== undefined) validateRecipient(raw.exportPublicKey);
  return {
    id: raw.id,
    apiKey: raw.apiKey,
    secretHash: raw.secretHash,
    exportPublicKey: raw.exportPublicKey,
    limits: raw.limits,
    ttl: raw.ttl ?? TtlSchema.parse({}),
    rpc: raw.rpc ?? {},
    allowDefaultRpc: raw.allowDefaultRpc ?? true,
    exportEnabled: raw.exportPublicKey !== undefined,
    origins: raw.origins ?? [],
  };
}

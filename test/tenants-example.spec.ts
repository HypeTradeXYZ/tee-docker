import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TenantsConfigSchema } from '../src/config/schemas';

/**
 * The example is a template someone copies verbatim, so it has to start.
 * These tests cover the schema layer only — see the note on the first case.
 *
 * It previously shipped a REPLACE_ME marker in `exportPublicKey`, which fails
 * the X25519 format check — a first-time self-hoster who copied it and edited
 * only the credentials got a service that refused to boot, reporting a key
 * format problem rather than an unedited placeholder.
 */
describe('config/tenants.example.json', () => {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', 'config', 'tenants.example.json'), 'utf8'),
  );

  /**
   * Parsing is not booting. RpcBoundaryService resolves every tenant `rpc`
   * endpoint over live DNS in onModuleInit and refuses to start on a failure,
   * which no unit test reaches — so this proves the schema layer only, and a
   * file that passes here can still fail closed at startup.
   */
  it('parses as shipped', () => {
    expect(TenantsConfigSchema.safeParse({ tenants: raw.tenants }).success).toBe(true);
  });

  /**
   * The marker is kept under `_exportPublicKey` so it stays visible to whoever
   * edits the file while the schema ignores it. That rests on TenantSchema not
   * being `.strict()`. If anyone makes it strict, fail here rather than in a
   * self-hoster's first boot.
   */
  it('ignores the underscore-prefixed marker instead of rejecting it', () => {
    const parsed = TenantsConfigSchema.safeParse({ tenants: raw.tenants });
    if (!parsed.success) throw new Error('example must parse');
    expect(parsed.data.tenants[0]).not.toHaveProperty('_exportPublicKey');
    expect(parsed.data.tenants[0]).not.toHaveProperty('exportPublicKey');
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRawTenant, readTenantsFile, writeTenantsFile } from '../src/admin/tenants-file';
import { TenantsConfigSchema } from '../src/config/schemas';

/**
 * The operator config carries content the zod schema deliberately drops: the
 * _comment block and the inert _-prefixed markers an operator renames to opt
 * in. Neither TenantSchema nor TenantsConfigSchema is .strict(), so a
 * write-back that round-tripped through the schema would erase all of it.
 */
const OPERATOR_FILE = {
  _comment: ['Copy to tenants.json and edit by hand.', 'The underscore keeps the marker inert.'],
  tenants: [
    {
      id: 'acme',
      apiKey: 'ak_live_0123456789abcdef',
      secretHash: '0'.repeat(64),
      _exportPublicKey: 'REPLACE_ME_WITH_X25519_BASE64_PUBLIC_KEY',
      limits: { maxWorkspaces: 5, maxWallets: 200, maxUnlockedWorkspaces: 8 },
      _rpc: { ethereum: 'https://rpc.example.com/eth' },
      allowDefaultRpc: true,
      _origins: ['https://app.example.com'],
    },
  ],
};

describe('tenants-file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tee-tenants-'));
    path = join(dir, 'tenants.json');
    writeFileSync(path, `${JSON.stringify(OPERATOR_FILE, null, 2)}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves the comment block and every inert marker across a write', () => {
    const file = readTenantsFile(path);
    const entry = findRawTenant(file, 'acme')!;
    (entry.limits as Record<string, number>).maxWallets = 500;
    writeTenantsFile(path, file.raw);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after._comment).toEqual(OPERATOR_FILE._comment);
    expect(after.tenants[0]._exportPublicKey).toBe(OPERATOR_FILE.tenants[0]._exportPublicKey);
    expect(after.tenants[0]._rpc).toEqual(OPERATOR_FILE.tenants[0]._rpc);
    expect(after.tenants[0]._origins).toEqual(OPERATOR_FILE.tenants[0]._origins);
    expect(after.tenants[0].limits.maxWallets).toBe(500);
  });

  it('demonstrates the loss a schema round-trip would have caused', () => {
    // Pinning the reason the writer works on the raw graph: if this ever stops
    // stripping, the guard rail is no longer load-bearing and can be revisited.
    const parsed = TenantsConfigSchema.parse(structuredClone(OPERATOR_FILE));
    expect(parsed).not.toHaveProperty('_comment');
    expect(parsed.tenants[0]).not.toHaveProperty('_exportPublicKey');
    expect(parsed.tenants[0]).not.toHaveProperty('_rpc');
  });

  it('leaves untouched fields byte-identical apart from the edit', () => {
    const file = readTenantsFile(path);
    (findRawTenant(file, 'acme')!.limits as Record<string, number>).maxWorkspaces = 9;
    writeTenantsFile(path, file.raw);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    const expected = structuredClone(OPERATOR_FILE) as typeof OPERATOR_FILE;
    expected.tenants[0]!.limits.maxWorkspaces = 9;
    expect(after).toEqual(expected);
  });

  it('keeps the operator’s file mode rather than widening it', () => {
    const file = readTenantsFile(path);
    (findRawTenant(file, 'acme')!.limits as Record<string, number>).maxWallets = 201;
    writeTenantsFile(path, file.raw);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    const file = readTenantsFile(path);
    (findRawTenant(file, 'acme')!.limits as Record<string, number>).maxWallets = 202;
    writeTenantsFile(path, file.raw);
    expect(readdirSync(dir)).toEqual(['tenants.json']);
  });

  it('returns null for a tenant the file does not list', () => {
    expect(findRawTenant(readTenantsFile(path), 'ghost')).toBeNull();
  });

  it('refuses a file that is not a tenants config', () => {
    writeFileSync(path, JSON.stringify({ nope: true }));
    expect(() => readTenantsFile(path)).toThrow(/no tenants array/);
  });

  it('refuses unparseable JSON rather than starting from a blank config', () => {
    writeFileSync(path, '{ broken');
    expect(() => readTenantsFile(path)).toThrow(/cannot read operator config/);
  });
});

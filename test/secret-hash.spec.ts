import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashApiSecret, verifyApiSecret } from '../src/auth/secret';
import type { Paths } from '../src/config/paths';
import { OperatorConfigService } from '../src/config/operator-config.service';
import { TenantSchema } from '../src/config/schemas';

const key = Buffer.alloc(32, 7);
const secret = 'machine-secret-0123456789';
const digest = hashApiSecret(secret, key);

function rawTenant(secretHash: string): unknown {
  return {
    id: 'acme',
    apiKey: 'ak_test_0123456789abcdef',
    secretHash,
    limits: { maxWorkspaces: 1, maxWallets: 1 },
  };
}

describe('tenant secretHash boundary', () => {
  it('produces canonical lowercase HMAC-SHA256 text without normalizing the secret', () => {
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe('6ca0c50fb76f1ea481a40127748c2e6d1fb7840959e5505f1b1ee320c06af8c0');
    expect(hashApiSecret('é', key)).not.toBe(hashApiSecret('e\u0301', key));
    expect(hashApiSecret(`${secret} `, key)).not.toBe(digest);
  });

  it.each([digest, digest.toUpperCase(), `${digest.slice(0, 17)}A${digest.slice(18)}`])(
    'accepts exact case-insensitive hexadecimal text',
    (value) => expect(TenantSchema.safeParse(rawTenant(value)).success).toBe(true),
  );

  it.each([
    '',
    digest.slice(1),
    `${digest}0`,
    `0x${digest}`,
    ` ${digest}`,
    `${digest} `,
    `${digest}\n`,
    `${digest}\t`,
    `g${digest.slice(1)}`,
    `${digest.slice(0, 31)}g${digest.slice(32)}`,
    `${digest.slice(0, 63)}g`,
    '０'.repeat(64),
    `${digest}zz`,
  ])('rejects malformed configured hash %p with a fixed path and message', (value) => {
    const parsed = TenantSchema.safeParse(rawTenant(value));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0]!;
    expect(issue.path).toEqual(['secretHash']);
    expect(issue.message).toBe('expected exactly 64 hexadecimal characters');
    if (value.length > 0) expect(JSON.stringify(issue)).not.toContain(value);
  });

  it('rejects malformed hashes before permissive hex decoding can authenticate suffix junk', () => {
    expect(verifyApiSecret(secret, digest, key)).toBe(true);
    expect(verifyApiSecret(secret, digest.toUpperCase(), key)).toBe(true);
    expect(verifyApiSecret('wrong', digest, key)).toBe(false);
    for (const malformed of [digest.slice(1), `${digest}zz`, `${digest}\n`, `g${digest.slice(1)}`]) {
      expect(verifyApiSecret(secret, malformed, key)).toBe(false);
    }
  });

  it('fails operator-config load with a pointed nonreflecting issue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-hash-config-'));
    const file = join(dir, 'tenants.json');
    const sentinel = `${digest}SECRET_SENTINEL`;
    writeFileSync(file, JSON.stringify({ tenants: [rawTenant(sentinel)] }));
    const paths = { tenantsFile: file } as Paths;
    try {
      let caught: unknown;
      try {
        OperatorConfigService.fromFile(paths);
      } catch (error) {
        caught = error;
      }
      const rendered = JSON.stringify(caught);
      expect(rendered).toContain('secretHash');
      expect(rendered).toContain('expected exactly 64 hexadecimal characters');
      expect(rendered).not.toContain(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

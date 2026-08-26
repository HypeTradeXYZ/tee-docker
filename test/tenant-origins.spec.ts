import { TenantSchema } from '../src/config/schemas';

const BASE = {
  id: 'acme',
  apiKey: 'ak_test_0123456789abcdef',
  secretHash: '0'.repeat(64),
  limits: { maxWorkspaces: 1, maxWallets: 1, maxUnlockedWorkspaces: 1 },
};

const parse = (origins: unknown) => TenantSchema.safeParse({ ...BASE, origins });

describe('tenant origins', () => {
  it('is optional, because a tenant with no browser client needs none', () => {
    expect(TenantSchema.safeParse(BASE).success).toBe(true);
  });

  it.each([
    ['https://app.example.com'],
    ['http://localhost:4321'],
    ['https://sub.domain.example.com:8443'],
  ])('accepts the origin %p', (origin) => {
    expect(parse([origin]).success).toBe(true);
  });

  // A browser never sends any of these as an Origin, so each is a config error
  // that would otherwise sit in the allowlist looking effective.
  it.each([
    ['*'],
    ['https://*.example.com'],
    ['https://app.example.com/'],
    ['https://app.example.com/path'],
    ['https://user:pass@app.example.com'],
    ['app.example.com'],
    ['ftp://app.example.com'],
    [''],
    // A browser lower-cases scheme and host when it serializes an Origin, and
    // the allowlist is matched by exact string — so an upper-case entry is
    // config that can never match, which is the whole point of this list.
    ['https://APP.example.com'],
    ['HTTPS://app.example.com'],
    ['https://Sub.Example.com'],
  ])('rejects %p', (origin) => {
    expect(parse([origin]).success).toBe(false);
  });

  // Same dead-config class as an upper-case origin: the key is looked up by
  // exact slug, so an unconstrained one is an endpoint that can never be used.
  it.each([['Ethereum'], ['eth mainnet'], ['ETHEREUM']])(
    'refuses an rpc map keyed by %p',
    (key) => {
      expect(TenantSchema.safeParse({ ...BASE, rpc: { [key]: 'https://a.example.com/x' } })
        .success).toBe(false);
    },
  );

  it('still accepts an rpc map keyed by a network slug', () => {
    expect(TenantSchema.safeParse({ ...BASE, rpc: { ethereum: 'https://a.example.com/x' } })
      .success).toBe(true);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';
import { newRecipient, unseal } from '../harness/unseal';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
/** Shortest plausible encoded key — enough to prove it is not empty or a stub. */
const MIN_PRIVATE_KEY_CHARS = 30;

/**
 * accounts-sign-export-flow — the workspace-tier domain routes:
 * account and wallet creation under the cross-workspace wallet quota,
 * signing, BYO RPC resolution, and sealed export.
 */
describe('accounts-sign-export-flow', () => {
  let harness: Harness;
  let token: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  const recipient = newRecipient();

  const TENANT = {
    ...DEFAULT_TENANT,
    exportPublicKey: recipient.configured,
    limits: { maxWorkspaces: 2, maxWallets: 8 },
    rpc: { ethereum: 'https://1.1.1.1/eth' },
  };

  beforeAll(async () => {
    harness = await boot({ tenants: [TENANT] });

    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'write', 'sign', 'export'] })
        .expect(201)
    ).body.token;
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('accounts and wallets', () => {
    it('creates an HD account, generating the mnemonic server-side', async () => {
      const res = await http()
        .post('/v1/accounts')
        .set(bearer())
        .send({ displayName: 'Trading Desk', kind: 'HD' })
        .expect(201);

      expect(res.body.generatedSecret).toBe(true);
      // A generated mnemonic must never appear in a plain response body — it
      // leaves only through the sealed export path.
      expect(JSON.stringify(res.body)).not.toMatch(/\b[a-z]+( [a-z]+){11}\b/);
      // hasOwnPassword is forced false; the library default is true.
      expect(res.body.account.hasOwnPassword).toBe(false);
    });

    it('derives wallets', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http()
        .post(`/v1/accounts/${slug}/wallets`)
        .set(bearer())
        .send({ count: 3 })
        .expect(201);
      expect(res.body.after).toBeGreaterThan(res.body.before);

      const wallets = await http().get(`/v1/accounts/${slug}/wallets`).set(bearer()).expect(200);
      expect(wallets.body.wallets.length).toBe(res.body.after);
      expect(wallets.body.wallets[0].addresses.length).toBeGreaterThan(0);
    });

    it('never leaks private key material in a wallet listing', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http().get(`/v1/accounts/${slug}/wallets`).set(bearer()).expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('_ciphertext');
      expect(body).not.toMatch(/"privateKey"/);
    });

    it('sets wallet tags', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const id = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer())).body.wallets[0].id;

      const res = await http()
        .put(`/v1/accounts/${slug}/wallets/${id}/tags`)
        .set(bearer())
        .send({ tags: ['hot', 'alpha'] })
        .expect(200);
      expect([...res.body.wallet.tags].sort()).toEqual(['alpha', 'hot']);
    });

    it('refuses to exceed the per-apiKey wallet quota', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http()
        .post(`/v1/accounts/${slug}/wallets`)
        .set(bearer())
        .send({ count: 500 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('quota_wallets_exceeded');
    });

    it('reports wallet usage against the tenant quota', async () => {
      const res = await http().get('/v1/quota').set(authHeaders()).expect(200);
      expect(res.body.wallets.used).toBeGreaterThan(0);
      expect(res.body.wallets.limit).toBe(8);
    });
  });

  describe('signing', () => {
    let address: string;

    beforeAll(async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const wallets = await http().get(`/v1/accounts/${slug}/wallets`).set(bearer());
      address = wallets.body.wallets[0].addresses.find(
        (a: { vm: string }) => a.vm === 'evm',
      ).publicKey;
    });

    it('signs a message', async () => {
      const res = await http()
        .post('/v1/sign/message')
        .set(bearer())
        .send({ address, message: 'hello tee-docker' })
        .expect(200);

      expect(res.body.address).toBe(address);
      expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
    });

    it('signs typed data, defaulting chainId to the address network', async () => {
      const typedData = {
        domain: { name: 'Test', version: '1', chainId: 1 },
        types: { Msg: [{ name: 'content', type: 'string' }] },
        primaryType: 'Msg',
        message: { content: 'hi' },
      };
      const res = await http()
        .post('/v1/sign/typed-data')
        .set(bearer())
        .send({ address, typedData })
        .expect(200);

      expect(res.body.signature).toMatch(/^0x/);
      expect(res.body.domainSeparator).toMatch(/^0x/);
    });

    it('404s an address outside this workspace', async () => {
      const res = await http()
        .post('/v1/sign/message')
        .set(bearer())
        .send({ address: '0x000000000000000000000000000000000000dEaD', message: 'x' });
      expect(res.status).toBe(404);
    });

    it('refuses to sign without the sign scope', async () => {
      const readOnly = (
        await http()
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read'] })
          .expect(201)
      ).body.token;

      const res = await http()
        .post('/v1/sign/message')
        .set({ authorization: `Bearer ${readOnly}` })
        .send({ address, message: 'x' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('scope_denied');
    });
  });

  describe('BYO RPC', () => {
    it('reports the tenant-configured endpoint as tenant-sourced', async () => {
      const res = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
      const eth = res.body.networks.find((n: { slug: string }) => n.slug === 'ethereum');
      // Seeded from the tenant config at workspace creation.
      expect(eth.rpcSource).toBe('tenant');
    });

    it('reports an unconfigured network as builtin', async () => {
      const res = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
      const other = res.body.networks.find((n: { slug: string }) => n.slug === 'base');
      expect(other.rpcSource).toBe('builtin');
    });

    it('accepts a per-workspace override', async () => {
      await http()
        .put('/v1/workspace/networks/base')
        .set(bearer())
        .send({ rpcUrl: 'https://1.1.1.1/base' })
        .expect(200);

      const res = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
      const base = res.body.networks.find((n: { slug: string }) => n.slug === 'base');
      expect(base.rpcSource).toBe('tenant');
    });

    it('rejects a non-URL endpoint', async () => {
      await http()
        .put('/v1/workspace/networks/base')
        .set(bearer())
        .send({ rpcUrl: 'not-a-url' })
        .expect(400);
    });
  });

  describe('sealed export', () => {
    it('seals a mnemonic that only the registered key can open', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http().post(`/v1/accounts/${slug}/export`).set(bearer()).expect(200);

      expect(res.body.sealed.alg).toBe('x25519-hkdf-sha256-aes256gcm');
      // The plaintext must not appear anywhere in the response.
      expect(JSON.stringify(res.body)).not.toMatch(/\b[a-z]+( [a-z]+){11}\b/);

      const mnemonic = unseal(res.body.sealed, recipient.privateKey);
      expect(mnemonic.split(/\s+/).length).toBeGreaterThanOrEqual(12);
    });

    it('produces a different blob each time — ephemeral sender key', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const a = await http().post(`/v1/accounts/${slug}/export`).set(bearer()).expect(200);
      const b = await http().post(`/v1/accounts/${slug}/export`).set(bearer()).expect(200);

      expect(a.body.sealed.ciphertext).not.toBe(b.body.sealed.ciphertext);
      expect(a.body.sealed.ephemeralPublicKey).not.toBe(b.body.sealed.ephemeralPublicKey);
      expect(unseal(a.body.sealed, recipient.privateKey)).toBe(
        unseal(b.body.sealed, recipient.privateKey),
      );
    });

    it('cannot be opened by a different key', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http().post(`/v1/accounts/${slug}/export`).set(bearer()).expect(200);

      const { privateKey: wrong } = generateKeyPairSync('x25519');
      expect(() => unseal(res.body.sealed, wrong)).toThrow();
    });

    it('seals and labels the explicitly selected EVM and SVM private keys', async () => {
      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const id = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer())).body.wallets[0].id;

      const exported = await Promise.all(
        (['evm', 'svm'] as const).map((vm) =>
          http()
            .post(`/v1/accounts/${slug}/wallets/${id}/export?vm=${vm}`)
            .set(bearer())
            .expect(200),
        ),
      );

      const keys = exported.map((res) => unseal(res.body.sealed, recipient.privateKey));
      expect(exported.map((res) => res.body.vm)).toEqual(['evm', 'svm']);
      expect(keys.every((key) => key.length > MIN_PRIVATE_KEY_CHARS)).toBe(true);
      expect(keys[0]).not.toBe(keys[1]);

      await http()
        .post(`/v1/accounts/${slug}/wallets/${id}/export`)
        .set(bearer())
        .expect(400);
    });

    it('refuses without the export scope', async () => {
      const noExport = (
        await http()
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'sign'] })
          .expect(201)
      ).body.token;

      const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
      const res = await http()
        .post(`/v1/accounts/${slug}/export`)
        .set({ authorization: `Bearer ${noExport}` });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('scope_denied');
    });
  });
});


describe('export disabled without a registered key', () => {
  let harness: Harness;

  beforeAll(async () => {
    // DEFAULT_TENANT has no exportPublicKey.
    harness = await boot();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses the export scope at mint time', async () => {
    const http = () => request(harness.app.getHttpServer());
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'export'] });

    // The gate is at mint time, so a token can never carry a scope the tenant
    // cannot actually use.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('export_disabled');
  });
});

import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { recoverAddress, Signature } from 'ethers';
import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

/**
 * sign-digest-bytes-flow — the raw signing primitives that make tee-docker a
 * pure custody-and-sign service: an EVM secp256k1 signature over a caller's
 * 32-byte digest, and an SVM ed25519 signature over caller bytes.
 *
 * A shape check is not enough here. Both outputs are bearer instruments the
 * caller broadcasts, so a "signs the wrong bytes" bug is silent and
 * catastrophic. Each endpoint is verified against an INDEPENDENT oracle —
 * ethers for secp256k1 recovery, node's own ed25519 for the Solana path — and
 * the digest signature is checked to bind to the exact digest with no re-hash.
 */

// A raw 32-byte ed25519 public key wrapped as SPKI DER, so node's verify can
// consume a Solana address directly — no external base58/ed25519 dependency.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function ed25519Verify(message: Buffer, signature: Buffer, rawPublicKey: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
    format: 'der',
    type: 'spki',
  });
  return nodeVerify(null, message, key, signature);
}

// Base58 (Bitcoin/Solana alphabet) decode — small and dependency-free.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = BASE58.indexOf(ch);
    if (value < 0) throw new Error(`invalid base58 character: ${ch}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of input) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

const WS_PASSWORD = 'Workspace-Passw0rd!x';
// A fixed, known 32-byte digest — sha256 is exactly 32 bytes and lowercase hex.
const DIGEST = `0x${createHash('sha256').update('tee-docker digest fidelity').digest('hex')}`;
const SVM_MESSAGE_TEXT = 'solana message bytes to sign verbatim';
const SVM_MESSAGE_HEX = `0x${Buffer.from(SVM_MESSAGE_TEXT).toString('hex')}`;

describe('sign-digest-bytes-flow', () => {
  let harness: Harness;
  let token: string;
  let evmAddress: string;
  let svmAddress: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string = token) => ({ authorization: `Bearer ${t}` });

  // maxWallets 10 covers the two single-wallet accounts this flow creates.
  const TENANT = { ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } };

  async function firstAddress(slug: string, vm: 'evm' | 'svm'): Promise<string> {
    let wallets = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer())).body.wallets;
    if (wallets.length === 0) {
      await http().post(`/v1/accounts/${slug}/wallets`).set(bearer()).send({ count: 1 }).expect(201);
      wallets = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer())).body.wallets;
    }
    const address = wallets[0].addresses.find((a: { vm: string }) => a.vm === vm);
    if (!address) throw new Error(`account ${slug} has no ${vm} address`);
    return address.publicKey;
  }

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
        .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'write', 'sign'] })
        .expect(201)
    ).body.token;

    // Two accounts pinned to explicit networks so each exposes the VM it signs
    // for, rather than relying on a default network's address composition.
    for (const [slug, network] of [
      ['evm-desk', 'ethereum'],
      ['svm-desk', 'solana'],
    ] as const) {
      await http()
        .post('/v1/accounts')
        .set(bearer())
        .send({ displayName: slug, kind: 'HD', defaultNetwork: network })
        .expect(201);
    }
    const list = (await http().get('/v1/accounts').set(bearer())).body.accounts as Array<{
      slug: string;
      defaultNetwork: string;
    }>;
    const evmSlug = list.find((a) => a.defaultNetwork === 'ethereum')!.slug;
    const svmSlug = list.find((a) => a.defaultNetwork === 'solana')!.slug;
    evmAddress = await firstAddress(evmSlug, 'evm');
    svmAddress = await firstAddress(svmSlug, 'svm');
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('POST /sign/digest (EVM secp256k1)', () => {
    it('signs the exact digest — the signature recovers to the address', async () => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: evmAddress, digest: DIGEST })
        .expect(200);

      expect(res.body.address).toBe(evmAddress);
      expect(res.body.r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.body.s).toMatch(/^0x[0-9a-f]{64}$/);
      expect([0, 1]).toContain(res.body.recovery);
      expect(res.body.signature).toMatch(/^0x[0-9a-f]{130}$/);

      // Independent oracle: the 65-byte signature must recover to this address
      // over THIS digest. If core re-hashed or prefixed, recovery would miss.
      const recovered = recoverAddress(DIGEST, res.body.signature);
      expect(recovered.toLowerCase()).toBe(evmAddress.toLowerCase());
      // The reported recovery byte is the real yParity of the signature.
      expect(Signature.from(res.body.signature).yParity).toBe(res.body.recovery);
    });

    it('binds the signature to that digest and no other (no re-hash)', async () => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: evmAddress, digest: DIGEST })
        .expect(200);

      // Recovering the same signature against a different digest must NOT land
      // on the signing address — proof the bytes signed were the digest itself.
      const otherDigest = `0x${'11'.repeat(32)}`;
      expect(recoverAddress(otherDigest, res.body.signature).toLowerCase()).not.toBe(
        evmAddress.toLowerCase(),
      );
    });

    it('is deterministic for the same digest (RFC 6979)', async () => {
      const send = () =>
        http()
          .post('/v1/sign/digest')
          .set(bearer())
          .send({ address: evmAddress, digest: DIGEST })
          .expect(200);
      const [a, b] = await Promise.all([send(), send()]);
      expect(a.body.signature).toBe(b.body.signature);
    });

    it('refuses an SVM address', async () => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: svmAddress, digest: DIGEST })
        .expect(422);
      expect(res.body.error.code).toBe('unsupported_for_kind');
    });

    it('404s an address outside this workspace', async () => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: '0x000000000000000000000000000000000000dEaD', digest: DIGEST })
        .expect(404);
      expect(res.body.error.code).toBe('account_not_found');
    });

    it.each([
      ['uppercase hex', `0x${'A'.repeat(64)}`],
      ['too short', `0x${'a'.repeat(62)}`],
      ['too long', `0x${'a'.repeat(66)}`],
      ['missing 0x prefix', 'a'.repeat(64)],
      ['not hex', `0x${'z'.repeat(64)}`],
    ])('rejects a %s digest', async (_label, digest) => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: evmAddress, digest })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_body');
    });

    it('rejects an unknown field', async () => {
      const res = await http()
        .post('/v1/sign/digest')
        .set(bearer())
        .send({ address: evmAddress, digest: DIGEST, chainId: 1 })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_body');
    });
  });

  describe('POST /sign/bytes (SVM ed25519)', () => {
    it('signs the exact bytes — the signature verifies under the address', async () => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: svmAddress, message: SVM_MESSAGE_HEX })
        .expect(200);

      expect(res.body.address).toBe(svmAddress);
      expect(res.body.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/); // base58
      expect(res.body.signatureHex).toMatch(/^0x[0-9a-f]{128}$/);

      // Independent oracle: node's ed25519 must accept this signature over the
      // exact message bytes, checked against the raw pubkey the address decodes to.
      const ok = ed25519Verify(
        Buffer.from(SVM_MESSAGE_TEXT),
        Buffer.from(res.body.signatureHex.slice(2), 'hex'),
        base58Decode(svmAddress),
      );
      expect(ok).toBe(true);
    });

    it('rejects a tampered message under the same signature', async () => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: svmAddress, message: SVM_MESSAGE_HEX })
        .expect(200);
      const ok = ed25519Verify(
        Buffer.from('a different message'),
        Buffer.from(res.body.signatureHex.slice(2), 'hex'),
        base58Decode(svmAddress),
      );
      expect(ok).toBe(false);
    });

    it('signs identical bytes whether given as hex or base64', async () => {
      const base64 = Buffer.from(SVM_MESSAGE_TEXT).toString('base64');
      const [viaHex, viaB64] = await Promise.all([
        http()
          .post('/v1/sign/bytes')
          .set(bearer())
          .send({ address: svmAddress, message: SVM_MESSAGE_HEX })
          .expect(200),
        http()
          .post('/v1/sign/bytes')
          .set(bearer())
          .send({ address: svmAddress, message: base64, encoding: 'base64' })
          .expect(200),
      ]);
      // Same bytes in, deterministic ed25519, so the two encodings agree.
      expect(viaHex.body.signatureHex).toBe(viaB64.body.signatureHex);
    });

    it('refuses an EVM address', async () => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: evmAddress, message: SVM_MESSAGE_HEX })
        .expect(422);
      expect(res.body.error.code).toBe('unsupported_for_kind');
    });

    it('404s an address outside this workspace, message permitting', async () => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: 'So11111111111111111111111111111111111111112', message: SVM_MESSAGE_HEX })
        .expect(404);
      expect(res.body.error.code).toBe('account_not_found');
    });

    it.each([
      ['empty', ''],
      ['odd-length hex', '0xabc'],
      ['uppercase hex', '0xAB'],
      ['non-hex', '0xzz'],
    ])('rejects a %s message', async (_label, message) => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: svmAddress, message })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_body');
    });

    it('rejects a message over the byte cap', async () => {
      const tooLong = `0x${'ab'.repeat(16 * 1024 + 1)}`;
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: svmAddress, message: tooLong })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_body');
    });

    it('rejects a value that is not valid base64 when base64 is declared', async () => {
      const res = await http()
        .post('/v1/sign/bytes')
        .set(bearer())
        .send({ address: svmAddress, message: '@@@not-base64@@@', encoding: 'base64' })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_body');
    });
  });

  describe('scope enforcement', () => {
    it('refuses both endpoints without the sign scope', async () => {
      const readOnly = (
        await http()
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read'] })
          .expect(201)
      ).body.token;

      const digest = await http()
        .post('/v1/sign/digest')
        .set(bearer(readOnly))
        .send({ address: evmAddress, digest: DIGEST })
        .expect(403);
      expect(digest.body.error.code).toBe('scope_denied');

      const bytes = await http()
        .post('/v1/sign/bytes')
        .set(bearer(readOnly))
        .send({ address: svmAddress, message: SVM_MESSAGE_HEX })
        .expect(403);
      expect(bytes.body.error.code).toBe('scope_denied');
    });
  });
});

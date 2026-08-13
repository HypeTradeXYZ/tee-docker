import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { TeeError } from '../common/tee-error';

export const SEAL_ALG = 'x25519-hkdf-sha256-aes256gcm';

export interface SealedBlob {
  alg: typeof SEAL_ALG;
  /** SHA-256 of the recipient's raw public key, first 16 hex chars. */
  recipientFingerprint: string;
  /** Base64 raw X25519 public key of the single-use sender key. */
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const RAW_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Parse `x25519:<base64>` from the operator config into a KeyObject.
 *
 * Accepts a raw 32-byte X25519 public key and wraps it in the SPKI header
 * Node requires, so operators can paste the key material itself rather than
 * hand-assembling DER.
 */
export function parseRecipient(configured: string): { key: ReturnType<typeof createPublicKey>; raw: Buffer } {
  const [scheme, encoded] = configured.split(':', 2);
  if (scheme !== 'x25519' || !encoded || configured !== `x25519:${encoded}`) {
    throw new TeeError('TEE_EXPORT_DISABLED', 'exportPublicKey must be "x25519:<base64>"');
  }

  const raw = Buffer.from(encoded, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== encoded) {
    throw new TeeError('TEE_EXPORT_DISABLED', 'exportPublicKey must decode to 32 bytes');
  }

  const key = createPublicKey({
    key: Buffer.concat([RAW_X25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return { key, raw };
}

/** Prove at boot that an operator recipient is both canonical and usable. */
export function validateRecipient(configured: string): void {
  try {
    const { key } = parseRecipient(configured);
    const ephemeral = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: key });
    if (shared.length !== 32 || shared.every((byte) => byte === 0)) {
      throw new Error('invalid X25519 agreement result');
    }
  } catch {
    // Config loading must never echo the key or an OpenSSL diagnostic.
    throw new Error('exportPublicKey is not a usable X25519 recipient');
  }
}

export function fingerprint(rawPublicKey: Buffer): string {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

/**
 * Seal a secret to a recipient's X25519 public key.
 *
 * Ephemeral-static ECDH: a fresh sender keypair per call, so two exports of
 * the same secret share no key material. The shared secret is bound to both
 * public keys through the HKDF salt, so a captured blob cannot be replayed
 * against a different recipient.
 *
 * Deliberately built from node:crypto primitives rather than a libsodium
 * sealed box: libsodium's construction needs XSalsa20-Poly1305, which Node
 * does not ship, and adding a native dependency to move 32 bytes is a worse
 * trade than a documented scheme a client can implement with WebCrypto.
 */
export function seal(plaintext: string, recipientConfigured: string): SealedBlob {
  const { key: recipientKey, raw: recipientRaw } = parseRecipient(recipientConfigured);

  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });

  const aesKey = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralRaw, recipientRaw]),
      `tee-docker:export:${SEAL_ALG}`,
      32,
    ),
  );

  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
  // Bind the ciphertext to the sender key, so the header cannot be swapped.
  cipher.setAAD(ephemeralRaw);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    alg: SEAL_ALG,
    recipientFingerprint: fingerprint(recipientRaw),
    ephemeralPublicKey: ephemeralRaw.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

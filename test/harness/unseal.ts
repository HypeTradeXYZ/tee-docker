import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import type { SealedBlob } from '../../src/export/seal';

const RAW_X25519_PUB_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * A client-side implementation of the export scheme, written only against the
 * documented fields of SealedBlob.
 *
 * This is the point of the test: if a caller cannot decrypt a sealed export
 * using standard primitives, the scheme is not usable no matter how correct
 * the server side is.
 */
export function unseal(blob: SealedBlob, recipientPrivate: KeyObject): string {
  const ephemeralRaw = Buffer.from(blob.ephemeralPublicKey, 'base64');
  const ephemeralPub = createPublicKey({
    key: Buffer.concat([RAW_X25519_PUB_PREFIX, ephemeralRaw]),
    format: 'der',
    type: 'spki',
  });

  const recipientRaw = createPublicKey(recipientPrivate)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);

  const shared = diffieHellman({ privateKey: recipientPrivate, publicKey: ephemeralPub });
  const aesKey = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralRaw, recipientRaw]),
      `tee-docker:export:${blob.alg}`,
      32,
    ),
  );

  const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(blob.nonce, 'base64'));
  decipher.setAAD(ephemeralRaw);
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function newRecipient(): { configured: string; privateKey: KeyObject } {
  // generateKeyPairSync already yields KeyObjects — no export/re-import needed.
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { configured: `x25519:${raw.toString('base64')}`, privateKey };
}

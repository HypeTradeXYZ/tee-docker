import { Injectable } from '@nestjs/common';

export const SERVER_KEY = Symbol('tee-docker:server-key');

/** Below this, the key is not doing its job. 32 hex chars = 16 bytes. */
const MIN_KEY_BYTES = 16;

/**
 * The HMAC key that `secretHash` values in the operator config are computed
 * under. Read once at boot from `TEE_SECRET_HMAC_KEY`.
 *
 * Absent or too short is a hard boot failure, never a generated default: a
 * random per-process key would make every configured `secretHash` fail to
 * verify, and a fixed fallback would be a published credential.
 */
@Injectable()
export class ServerKeyProvider {
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
    const raw = env.TEE_SECRET_HMAC_KEY;

    if (!raw || raw.length === 0) {
      throw new Error(
        'TEE_SECRET_HMAC_KEY is not set. It is the key every tenant secretHash is ' +
          'computed under; there is no safe default. Generate one with: ' +
          'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }

    const key = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'utf8');

    if (key.length < MIN_KEY_BYTES) {
      throw new Error(
        `TEE_SECRET_HMAC_KEY is too short (${key.length} bytes, need >= ${MIN_KEY_BYTES}).`,
      );
    }

    return key;
  }
}

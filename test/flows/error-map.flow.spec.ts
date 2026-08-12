import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ErrorsConfigSchema } from '../../src/config/schemas';
import { ErrorMapService } from '../../src/config/error-map.service';
import { TEE_ERROR_CODES } from '../../src/common/tee-error';

/**
 * Every wative-core error code as of 2.4.3. Hardcoded deliberately: if the
 * library adds a code in a minor release, this list is where we notice the
 * gap, rather than a caller receiving an opaque 500 in production.
 */
const WATIVE_ERROR_CODES = [
  'WORKSPACE_LOCKED',
  'ACCOUNT_LOCKED',
  'RECORD_LOCKED',
  'BAD_PASSWORD',
  'WEAK_PASSWORD',
  'RECORD_NOT_FOUND',
  'PROVIDER_IO',
  'PERMISSION_DENIED',
  'DISK_FULL',
  'PARAMETER_ERROR',
  'DECRYPT_FAILED',
  'ENCRYPT_FAILED',
  'ALGORITHM_IRREVERSIBLE',
  'INVALID_MNEMONIC',
  'INVALID_PRIVATE_KEY',
  'UNSUPPORTED_NETWORK',
  'TX_BUILD_FAILED',
  'TX_SIGN_FAILED',
  'TX_SUBMIT_FAILED',
  'TX_TIMEOUT',
  'TX_DROPPED',
  'RPC_UNREACHABLE',
  'STORAGE_NOT_DURABLE',
  'UNSUPPORTED_OP',
] as const;

describe('error-map', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../../config/errors.json'), 'utf8')),
  );
  const service = new ErrorMapService(config);

  it.each(WATIVE_ERROR_CODES)('maps wative-core code %s', (code) => {
    expect(service.resolve(code).unmapped).toBe(false);
  });

  it.each(TEE_ERROR_CODES)('maps tee-docker code %s', (code) => {
    expect(service.resolve(code).unmapped).toBe(false);
  });

  it('degrades an unknown code to the default status instead of throwing', () => {
    const resolved = service.resolve('SOME_FUTURE_CODE_FROM_A_MINOR_RELEASE');
    expect(resolved).toMatchObject({
      unmapped: true,
      status: config.defaultStatus,
      code: 'internal_error',
      exposeDetails: false,
    });
  });

  it('never exposes details unless a mapping opts in', () => {
    const optedIn = service.mappedCodes.filter((c) => service.resolve(c).exposeDetails);
    // details is an arbitrary object; forwarding it is how internal state
    // leaves the enclave. Anything here must be a deliberate choice:
    //   TEE_INVALID_SLUG   -> tells the caller the accepted slug charset
    //   TEE_ACCOUNT_LOCKED -> names which account needs unlocking
    //   TEE_SCOPE_DENIED   -> names which scope the token lacks
    //   TEE_RPC_NOT_CONFIGURED -> names which network has no endpoint
    //   TEE_SESSION_CAPACITY -> names only the exhausted scope and configured limit
    expect(new Set(optedIn)).toEqual(
      new Set([
        'TEE_INVALID_SLUG',
        'TEE_ACCOUNT_LOCKED',
        'TEE_SCOPE_DENIED',
        'TEE_RPC_NOT_CONFIGURED',
        'TEE_UNLOCK_CAPACITY',
        'TEE_SESSION_CAPACITY',
      ]),
    );
  });

  it('uses a sane status for every mapping', () => {
    for (const code of service.mappedCodes) {
      const { status } = service.resolve(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

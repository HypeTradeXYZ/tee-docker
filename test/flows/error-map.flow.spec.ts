import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ErrorsConfigSchema } from '../../src/config/schemas';
import { ErrorMapService } from '../../src/config/error-map.service';
import { TEE_ERROR_CODES } from '../../src/common/tee-error';
import { WATIVE_ERROR_CODES } from '../../src/common/wative-error-codes';

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

  it('has one unique mapping for every reviewed core and tee code', () => {
    const reviewed = [...WATIVE_ERROR_CODES, ...TEE_ERROR_CODES];
    expect(new Set(reviewed).size).toBe(reviewed.length);
    expect(new Set(service.mappedCodes)).toEqual(new Set(reviewed));
  });

  it('maps abort and endpoint rejection with reviewed public semantics', () => {
    expect(service.resolve('TX_ABORTED')).toMatchObject({
      status: 409,
      code: 'tx_aborted',
      exposeDetails: false,
      exposeMessage: false,
    });
    expect(service.resolve('RPC_REJECTED')).toMatchObject({
      status: 502,
      code: 'rpc_rejected',
      exposeDetails: false,
      exposeMessage: true,
      publicMessage: 'the RPC endpoint rejected the request',
    });
  });

  it('keeps request-shape and target-kind errors distinct and opaque', () => {
    expect(service.resolve('TEE_INVALID_BODY')).toMatchObject({
      status: 400,
      code: 'invalid_body',
      exposeDetails: false,
    });
    expect(service.resolve('TEE_UNSUPPORTED_FOR_KIND')).toMatchObject({
      status: 422,
      code: 'unsupported_for_kind',
      exposeDetails: false,
    });
  });

  it('refuses construction when a reviewed mapping is missing', () => {
    const mappings = { ...config.mappings };
    delete mappings.RPC_REJECTED;
    expect(() => new ErrorMapService({ ...config, mappings })).toThrow(
      'error map is missing reviewed codes: RPC_REJECTED',
    );
  });

  it('refuses unreviewed mapping keys and misspelled mapping options', () => {
    expect(() =>
      new ErrorMapService({
        ...config,
        mappings: {
          ...config.mappings,
          RPC_REJECTEDD: { status: 502, code: 'rpc_rejected' },
        },
      }),
    ).toThrow('error map has unreviewed codes: RPC_REJECTEDD');

    expect(() =>
      ErrorsConfigSchema.parse({
        ...config,
        mappings: {
          ...config.mappings,
          RPC_REJECTED: {
            ...config.mappings.RPC_REJECTED,
            exposeMesssage: true,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      ErrorsConfigSchema.parse({
        ...config,
        mappings: {
          ...config.mappings,
          RPC_REJECTED: {
            status: 502,
            code: 'rpc_rejected',
            exposeMessage: true,
          },
        },
      }),
    ).toThrow('an exposeMessage mapping requires a fixed publicMessage');
  });

  it('degrades an unknown code to the default status instead of throwing', () => {
    const resolved = service.resolve('SOME_FUTURE_CODE_FROM_A_MINOR_RELEASE');
    expect(resolved).toMatchObject({
      unmapped: true,
      status: config.defaultStatus,
      code: 'internal_error',
      exposeDetails: false,
      exposeMessage: false,
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
    //   TEE_ACCOUNT_UNLOCK_RATE -> names only a finite retry delay
    //   TEE_RPC_CAPACITY -> names only the exhausted scope and configured limit
    //   workspace creation/cooldown limits -> name only a finite retry delay
    expect(new Set(optedIn)).toEqual(
      new Set([
        'TEE_INVALID_SLUG',
        'TEE_ACCOUNT_LOCKED',
        'TEE_SCOPE_DENIED',
        'TEE_RPC_NOT_CONFIGURED',
        'TEE_UNLOCK_CAPACITY',
        'TEE_SESSION_CAPACITY',
        'TEE_ACCOUNT_UNLOCK_RATE',
        'TEE_RPC_CAPACITY',
        'TEE_WORKSPACE_CREATE_RATE',
        'TEE_WORKSPACE_RECREATE_COOLDOWN',
      ]),
    );
  });

  it('exposes 5xx messages only through the reviewed fixed-message allowlist', () => {
    const optedIn = service.mappedCodes.filter((c) => service.resolve(c).exposeMessage);
    expect(new Set(optedIn)).toEqual(new Set([
      'DISK_FULL',
      'TX_SUBMIT_FAILED',
      'TX_TIMEOUT',
      'RPC_UNREACHABLE',
      'RPC_REJECTED',
      'UNSUPPORTED_OP',
      'TEE_RPC_UNREACHABLE',
      'TEE_BALANCES_UNAVAILABLE',
    ]));
    for (const code of optedIn) {
      expect(service.resolve(code).publicMessage).toEqual(expect.any(String));
    }
  });

  it('uses a sane status for every mapping', () => {
    for (const code of service.mappedCodes) {
      const { status } = service.resolve(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

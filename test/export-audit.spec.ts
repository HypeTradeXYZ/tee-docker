import { generateKeyPairSync } from 'node:crypto';
import { ExportController } from '../src/export/export.controller';
import { TeeError } from '../src/common/tee-error';

function recipient(): string {
  const { publicKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return `x25519:${raw.toString('base64')}`;
}

describe('export audit boundary', () => {
  const session = { workspaceSlug: 'desk-a' } as never;
  const tenant = {
    id: 'acme',
    exportEnabled: true,
    exportPublicKey: recipient(),
  } as never;

  function setup(account: unknown) {
    const sessions = { requireAccount: jest.fn().mockResolvedValue(account) };
    const controller = new ExportController(sessions as never);
    const logger = { log: jest.fn(), warn: jest.fn() };
    Object.defineProperty(controller, 'logger', { value: logger });
    return { controller, sessions, logger };
  }

  it.each(['', ' ', '-1', '1.5', '1e2', '0x10', '01', 'NaN', 'Infinity', '9007199254740992', '1\nforged']) (
    'rejects malformed wallet id %p before account lookup or logging',
    async (id) => {
      const { controller, sessions, logger } = setup({});
      await expect(controller.privateKey(session, tenant, 'desk', id, 'evm')).rejects.toMatchObject({
        code: 'TEE_INVALID_SLUG',
      });
      expect(sessions.requireAccount).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', ' ', 'EVM', 'sui', 'evm,svm', ['evm'], ['evm', 'svm'], 1, {}])(
    'rejects ambiguous or unsupported VM selector %p before account lookup or logging',
    async (vm) => {
      const { controller, sessions, logger } = setup({});
      await expect(controller.privateKey(session, tenant, 'desk', '0', vm)).rejects.toMatchObject({
        code: 'PARAMETER_ERROR',
      });
      expect(sessions.requireAccount).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['evm', 'svm'] as const)(
    'uses the explicit %s selector independent of address order and echoes it everywhere',
    async (vm) => {
      const dumpPrivateKey = jest.fn().mockReturnValue(`${vm}-private-key`);
      const { controller, logger } = setup({
        slug: 'desk',
        wallets: {
          byId: () => ({
            id: 0,
            addresses: [{ vm: 'svm' }, { vm: 'evm' }],
            dumpPrivateKey,
          }),
        },
      });

      const result = await controller.privateKey(session, tenant, 'desk', '0', vm);
      expect(dumpPrivateKey).toHaveBeenCalledWith(vm);
      expect(result.vm).toBe(vm);
      expect(logger.log.mock.calls.map(([record]) => record)).toEqual([
        expect.objectContaining({ outcome: 'ATTEMPT', vm }),
        expect.objectContaining({ outcome: 'SUCCESS', vm }),
      ]);
    },
  );

  it('rejects an unavailable selected VM without dumping or falling back', async () => {
    const dumpPrivateKey = jest.fn();
    const { controller, logger } = setup({
      slug: 'desk',
      wallets: {
        byId: () => ({ id: 0, addresses: [{ vm: 'evm' }], dumpPrivateKey }),
      },
    });

    await expect(controller.privateKey(session, tenant, 'desk', '0', 'svm')).rejects.toMatchObject({
      code: 'PARAMETER_ERROR',
    });
    expect(dumpPrivateKey).not.toHaveBeenCalled();
    expect(logger.log.mock.calls[0]?.[0]).toMatchObject({ outcome: 'ATTEMPT', vm: 'svm' });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ outcome: 'FAILURE', vm: 'svm' });
  });

  it('uses a parsed numeric id and records attempt plus failure for a missing wallet', async () => {
    const byId = jest.fn().mockReturnValue(undefined);
    const { controller, logger } = setup({ wallets: { byId } });

    await expect(controller.privateKey(session, tenant, 'desk', '7', 'evm')).rejects.toBeInstanceOf(
      TeeError,
    );
    expect(byId).toHaveBeenCalledWith(7);
    expect(logger.log).toHaveBeenCalledWith({
      event: 'key_export',
      outcome: 'ATTEMPT',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'privateKey',
      walletId: 7,
      vm: 'evm',
    });
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'key_export',
      outcome: 'FAILURE',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'privateKey',
      walletId: 7,
      vm: 'evm',
    });
  });

  it('records a disabled export as an attempt and one terminal failure without account access', async () => {
    const { controller, sessions, logger } = setup({});
    const disabled = { id: 'acme', exportEnabled: false } as never;

    await expect(controller.mnemonic(session, disabled, 'desk')).rejects.toMatchObject({
      code: 'TEE_EXPORT_DISABLED',
    });
    expect(sessions.requireAccount).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0]?.[0]).toMatchObject({ outcome: 'ATTEMPT' });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ outcome: 'FAILURE' });
  });

  it('records account and account-kind failures without replacing the original rejection', async () => {
    const lookupError = new Error('lookup failed');
    const lookup = setup({});
    lookup.sessions.requireAccount.mockRejectedValueOnce(lookupError);
    await expect(lookup.controller.mnemonic(session, tenant, 'desk')).rejects.toBe(lookupError);
    expect(lookup.logger.log.mock.calls.map(([record]) => record.outcome)).toEqual(['ATTEMPT']);
    expect(lookup.logger.warn.mock.calls.map(([record]) => record.outcome)).toEqual(['FAILURE']);

    const wrongKind = setup({ slug: 'desk', organizationType: 'PK' });
    await expect(wrongKind.controller.mnemonic(session, tenant, 'desk')).rejects.toBeInstanceOf(
      TeeError,
    );
    expect(wrongKind.logger.log.mock.calls.map(([record]) => record.outcome)).toEqual(['ATTEMPT']);
    expect(wrongKind.logger.warn.mock.calls.map(([record]) => record.outcome)).toEqual(['FAILURE']);
  });

  it('emits success only after a real mnemonic has been sealed without logging secret material', async () => {
    const secret = 'abandon '.repeat(11) + 'about';
    const { controller, logger } = setup({
      slug: 'desk',
      organizationType: 'HD',
      dumpMnemonic: jest.fn().mockReturnValue(secret),
    });

    const result = await controller.mnemonic(session, tenant, 'desk');
    expect(result.sealed.ciphertext).toBeTruthy();
    expect(logger.log).toHaveBeenNthCalledWith(1, {
      event: 'key_export',
      outcome: 'ATTEMPT',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'mnemonic',
    });
    expect(logger.log).toHaveBeenNthCalledWith(2, {
      event: 'key_export',
      outcome: 'SUCCESS',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'mnemonic',
    });
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls])).not.toContain(
      secret,
    );
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls])).not.toContain(
      result.sealed.ciphertext,
    );
  });

  it('records a numeric wallet id and no key material for a successful private-key export', async () => {
    const privateKey = 'private-key-plaintext';
    const { controller, logger } = setup({
      slug: 'desk',
      wallets: {
        byId: (id: number) => ({
          id,
          addresses: [{ vm: 'evm' }],
          dumpPrivateKey: () => privateKey,
        }),
      },
    });

    const result = await controller.privateKey(session, tenant, 'desk', '0', 'evm');
    expect(result.walletId).toBe(0);
    expect(result.vm).toBe('evm');
    expect(logger.log).toHaveBeenNthCalledWith(2, {
      event: 'key_export',
      outcome: 'SUCCESS',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'privateKey',
      walletId: 0,
      vm: 'evm',
    });
    const audit = JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls]);
    expect(audit).not.toContain(privateKey);
    expect(audit).not.toContain(result.sealed.ciphertext);
  });

  it('records one failure and no success when private-key dumping fails', async () => {
    const { controller, logger } = setup({
      slug: 'desk',
      wallets: {
        byId: () => ({
          id: 0,
          addresses: [{ vm: 'evm' }],
          dumpPrivateKey: () => {
            throw new Error('key material must not reach the audit record');
          },
        }),
      },
    });

    await expect(controller.privateKey(session, tenant, 'desk', '0', 'evm')).rejects.toThrow(
      'key material must not reach the audit record',
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ outcome: 'FAILURE', walletId: 0 });
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls])).not.toContain(
      'key material must not reach the audit record',
    );
  });

  it('records one failure when mnemonic dumping or wallet VM selection fails', async () => {
    const dumpError = new Error('mnemonic dump failed');
    const mnemonic = setup({
      slug: 'desk',
      organizationType: 'HD',
      dumpMnemonic: jest.fn(() => { throw dumpError; }),
    });
    await expect(mnemonic.controller.mnemonic(session, tenant, 'desk')).rejects.toBe(dumpError);
    expect(mnemonic.logger.log.mock.calls.map(([record]) => record.outcome)).toEqual(['ATTEMPT']);
    expect(mnemonic.logger.warn.mock.calls.map(([record]) => record.outcome)).toEqual(['FAILURE']);

    const addressless = setup({
      slug: 'desk',
      wallets: { byId: () => ({ id: 0, addresses: [] }) },
    });
    await expect(
      addressless.controller.privateKey(session, tenant, 'desk', '0', 'evm'),
    ).rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
    expect(addressless.logger.log.mock.calls.map(([record]) => record.outcome)).toEqual(['ATTEMPT']);
    expect(addressless.logger.warn.mock.calls.map(([record]) => record.outcome)).toEqual(['FAILURE']);
  });

  it('records attempt then failure when sealing fails without logging the secret or error', async () => {
    const secret = 'mnemonic material must remain private';
    const unusableRecipient = {
      id: 'acme',
      exportEnabled: true,
      exportPublicKey: 'x25519:not-a-32-byte-key',
    } as never;
    const { controller, logger } = setup({
      slug: 'desk',
      organizationType: 'HD',
      dumpMnemonic: jest.fn().mockReturnValue(secret),
    });

    await expect(controller.mnemonic(session, unusableRecipient, 'desk')).rejects.toMatchObject({
      code: 'TEE_EXPORT_DISABLED',
    });
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0]?.[0]).toMatchObject({ outcome: 'ATTEMPT' });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ outcome: 'FAILURE' });
    expect(logger.log.mock.invocationCallOrder[0]).toBeLessThan(
      logger.warn.mock.invocationCallOrder[0]!,
    );
    const audit = JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls]);
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain('not-a-32-byte-key');
    expect(audit).not.toContain('decode to 32 bytes');
  });

  it('does not relabel a successful export when the success audit sink throws', async () => {
    const { controller, logger } = setup({
      slug: 'desk',
      organizationType: 'HD',
      dumpMnemonic: jest.fn().mockReturnValue('abandon '.repeat(11) + 'about'),
    });
    const auditError = new Error('audit sink failed');
    logger.log
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw auditError; });

    await expect(controller.mnemonic(session, tenant, 'desk')).rejects.toBe(auditError);
    expect(logger.log.mock.calls.map(([record]) => record.outcome)).toEqual([
      'ATTEMPT',
      'SUCCESS',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the operation error when the failure audit sink also throws', async () => {
    const operationError = new Error('dump failed');
    const { controller, logger } = setup({
      slug: 'desk',
      organizationType: 'HD',
      dumpMnemonic: jest.fn(() => { throw operationError; }),
    });
    logger.warn.mockImplementationOnce(() => { throw new Error('audit sink failed'); });

    await expect(controller.mnemonic(session, tenant, 'desk')).rejects.toBe(operationError);
    expect(logger.log.mock.calls.map(([record]) => record.outcome)).toEqual(['ATTEMPT']);
    expect(logger.warn.mock.calls.map(([record]) => record.outcome)).toEqual(['FAILURE']);
  });
});

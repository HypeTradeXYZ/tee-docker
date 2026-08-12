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
      await expect(controller.privateKey(session, tenant, 'desk', id)).rejects.toMatchObject({
        code: 'TEE_INVALID_SLUG',
      });
      expect(sessions.requireAccount).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('uses a parsed numeric id and records attempt plus failure for a missing wallet', async () => {
    const byId = jest.fn().mockReturnValue(undefined);
    const { controller, logger } = setup({ wallets: { byId } });

    await expect(controller.privateKey(session, tenant, 'desk', '7')).rejects.toBeInstanceOf(
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
    });
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'key_export',
      outcome: 'FAILURE',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'privateKey',
      walletId: 7,
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

    const result = await controller.privateKey(session, tenant, 'desk', '0');
    expect(result.walletId).toBe(0);
    expect(logger.log).toHaveBeenNthCalledWith(2, {
      event: 'key_export',
      outcome: 'SUCCESS',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      accountSlug: 'desk',
      target: 'privateKey',
      walletId: 0,
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

    await expect(controller.privateKey(session, tenant, 'desk', '0')).rejects.toThrow(
      'key material must not reach the audit record',
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ outcome: 'FAILURE', walletId: 0 });
    expect(JSON.stringify([...logger.log.mock.calls, ...logger.warn.mock.calls])).not.toContain(
      'key material must not reach the audit record',
    );
  });
});

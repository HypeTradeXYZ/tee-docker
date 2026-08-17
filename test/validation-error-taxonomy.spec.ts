import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AuthController } from '../src/auth/auth.controller';
import { ExportController } from '../src/export/export.controller';
import { AccountsController } from '../src/session/accounts.controller';
import { AccountsService } from '../src/session/accounts.service';
import { NetworksController } from '../src/session/networks.controller';
import { SignController } from '../src/session/sign.controller';
import { TransactionsController } from '../src/session/transactions.controller';
import { WorkspaceController } from '../src/session/workspace.controller';
import { WorkspacesController } from '../src/workspaces/workspaces.controller';
import { parseNetworkSelector } from '../src/session/network-selector';

const SRC = join(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('validation error taxonomy', () => {
  const forbidden = new Proxy({}, {
    get() {
      throw new Error('downstream dependency was touched');
    },
  });
  const session = {} as never;
  const tenant = {} as never;
  const response = { setHeader: jest.fn() } as never;

  it.each([
    ['workspace create', () => new WorkspacesController(forbidden as never).create(tenant, null)],
    ['token mint', () => new AuthController(forbidden as never, forbidden as never, forbidden as never)
      .token(tenant, null)],
    ['token refresh', () => new AuthController(forbidden as never, forbidden as never, forbidden as never)
      .refresh(tenant, session, 'lease', { extra: true }, response)],
    ['account create', () => new AccountsController(forbidden as never, forbidden as never, forbidden as never)
      .create(session, tenant, null)],
    ['wallet derive', () => new AccountsController(forbidden as never, forbidden as never, forbidden as never)
      .derive(session, tenant, 'account-a', null)],
    ['key import', () => new AccountsController(forbidden as never, forbidden as never, forbidden as never)
      .importKey(session, tenant, 'account-a', null)],
    ['tag replace', () => new AccountsController(forbidden as never, forbidden as never, forbidden as never)
      .setTags(session, 'account-a', '0', null)],
    ['RPC update', () => new NetworksController(forbidden as never).setRpc(session, tenant, 'ethereum', null)],
    ['message sign', () => new SignController(forbidden as never).message(session, null)],
    ['typed-data sign', () => new SignController(forbidden as never).typedData(session, null)],
    ['transaction build', () => new TransactionsController(forbidden as never, forbidden as never, forbidden as never)
      .build(session, tenant, null, response)],
    ['account unlock', () => new WorkspaceController(forbidden as never, forbidden as never)
      .unlock(session, tenant, 'account-a', null)],
  ])('classifies malformed %s bodies before downstream work', async (_name, invoke) => {
    await expect((async () => { await invoke(); })()).rejects.toMatchObject({
      code: 'TEE_INVALID_BODY',
      details: undefined,
    });
  });

  it('classifies conditional PK input and wrong account kind before state mutation', async () => {
    const mutate = jest.fn();
    const requireAccount = jest.fn().mockResolvedValue({ organizationType: 'PK' });
    const service = new AccountsService({ requireAccount } as never, { mutate } as never);

    await expect(service.create(session, tenant, {
      displayName: 'Valid account name',
      kind: 'PK',
    })).rejects.toMatchObject({ code: 'TEE_INVALID_BODY' });
    expect(mutate).not.toHaveBeenCalled();

    await expect(service.deriveWallets(session, tenant, 'account-a', 1)).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
    });
    expect(requireAccount).toHaveBeenCalledWith(session, 'account-a');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a private-key import addressed to an HD account, before quota work', async () => {
    // L-06. Without this the whole suite stays green with the guard deleted:
    // the only coverage was fixtures that happened to keep passing.
    const mutate = jest.fn();
    const requireAccount = jest.fn().mockResolvedValue({ organizationType: 'HD' });
    const service = new AccountsService({ requireAccount } as never, { mutate } as never);

    await expect(
      service.importPrivateKey(session, tenant, 'account-a', '0xabc'),
    ).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
      message: 'only a PK account can import a private key',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'pk', ' PK', ['PK']])(
    'fails closed for the non-PK organizationType %p',
    async (organizationType) => {
      const mutate = jest.fn();
      const requireAccount = jest.fn().mockResolvedValue({ organizationType });
      const service = new AccountsService({ requireAccount } as never, { mutate } as never);

      await expect(
        service.importPrivateKey(session, tenant, 'account-a', '0xabc'),
      ).rejects.toMatchObject({ code: 'TEE_UNSUPPORTED_FOR_KIND' });
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('rejects hasOwnPassword without accountPassword, and the reverse', async () => {
    // L-07. The flag is meaningless without a distinct password, and a
    // password without the flag would be silently ignored.
    const mutate = jest.fn();
    const service = new AccountsService({} as never, { mutate } as never);

    await expect(service.create(session, tenant, {
      displayName: 'Valid account name',
      kind: 'HD',
      hasOwnPassword: true,
    })).rejects.toMatchObject({ code: 'TEE_INVALID_BODY' });

    await expect(service.create(session, tenant, {
      displayName: 'Valid account name',
      kind: 'HD',
      accountPassword: 'Vault-Passw0rd!x',
    })).rejects.toMatchObject({ code: 'TEE_INVALID_BODY' });

    expect(mutate).not.toHaveBeenCalled();
  });

  it('holds an account password to the same policy as a workspace password', async () => {
    // Otherwise the Cold Vault's only secret could be weaker than the password
    // guarding the workspace around it.
    const mutate = jest.fn();
    const service = new AccountsService({} as never, { mutate } as never);

    await expect(service.create(session, tenant, {
      displayName: 'Valid account name',
      kind: 'HD',
      hasOwnPassword: true,
      accountPassword: 'a',
    })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('classifies unsupported scopes and VM kind without reflecting caller values', async () => {
    const check = jest.fn();
    const create = jest.fn();
    const knowsWorkspace = jest.fn().mockReturnValue(true);
    const auth = new AuthController(
      { create, knowsWorkspace } as never,
      forbidden as never,
      { check } as never,
    );
    await expect(auth.token({ id: 'acme' } as never, {
      workspace: 'desk-a',
      password: 'password',
      scopes: ['SECRET-unknown-scope'],
    })).rejects.toMatchObject({
      code: 'TEE_INVALID_BODY',
      message: 'requested scopes are not supported',
    });
    // L-10: an unsupported scope is pure validation, so it must not spend the
    // tenant's mint budget, which is shared with account unlock.
    expect(check).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const address = {
      publicKey: 'svm-address',
      vm: 'svm',
      signTypedData: jest.fn(),
    };
    const account = {
      slug: 'account-a',
      wallets: [{ addresses: [address] }],
    };
    const requireAccount = jest.fn().mockResolvedValue(account);
    const typed = new SignController({ requireAccount } as never);
    const ownedSession = {
      handle: {
        filter: () => address,
        accounts: Object.assign([account], { find: Array.prototype.find }),
      },
    } as never;
    await expect(typed.typedData(ownedSession, {
      address: 'svm-address',
      typedData: { secret: 'SECRET-typed-data' },
    })).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
      message: 'typed-data signing is EVM only',
    });
    expect(requireAccount).toHaveBeenCalledWith(ownedSession, 'account-a');
    expect(address.signTypedData).not.toHaveBeenCalled();
  });

  it('uses invalid_parameter for non-body route and query selectors before lookup', async () => {
    const workspaces = { remove: jest.fn() };
    await expect(new WorkspacesController(workspaces as never)
      .remove(tenant, 'desk-a', 'yes')).rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
    expect(workspaces.remove).not.toHaveBeenCalled();

    for (const network of [undefined, '', ' ', ['ethereum'], ['ethereum', 'solana'], {}, 'x'.repeat(129)]) {
      await expect(new WorkspaceController(forbidden as never, forbidden as never)
        .assets(session, network)).rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
      await expect(new TransactionsController(forbidden as never, forbidden as never, forbidden as never)
        .status(session, tenant, 'hash', network, response)).rejects.toMatchObject({
        code: 'PARAMETER_ERROR',
      });
    }
    await expect(new ExportController(forbidden as never)
      .privateKey(session, tenant, 'account-a', '1.5', 'evm')).rejects.toMatchObject({
      code: 'PARAMETER_ERROR',
    });
  });

  it.each(['', ' ', '-1', '1.5', '1e0', '0x1', '01', '9007199254740992']) (
    'rejects wallet-id alias %p before account lookup or tag mutation',
    async (id) => {
      const requireAccount = jest.fn();
      const replace = jest.fn();
      const controller = new AccountsController({} as never, { requireAccount } as never, {
        replace,
      } as never);

      await expect(controller.addresses(session, 'account-a', id)).rejects.toMatchObject({
        code: 'PARAMETER_ERROR',
      });
      await expect(controller.setTags(session, 'account-a', id, { tags: ['safe'] }))
        .rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
      expect(requireAccount).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it('reserves invalid_slug exclusively for the reviewed slug boundary', () => {
    const occurrences = sourceFiles(SRC).flatMap((path) => {
      const count = readFileSync(path, 'utf8').split('TEE_INVALID_SLUG').length - 1;
      return Array.from({ length: count }, () => relative(SRC, path));
    });
    expect(occurrences.sort()).toEqual([
      'common/tee-error.ts',
      'session/account-slug.ts',
      'workspaces/workspace-paths.ts',
      'workspaces/workspace-paths.ts',
    ]);
  });
});

describe('network selector grammar (L-05)', () => {
  it.each([
    ['__proto__', '__proto__'],
    ['a NUL byte', 'a\u0000b'],
    ['a path traversal', '../../etc/passwd'],
    ['a zero-width space', 'a\u200Bb'],
    ['uppercase', 'Ethereum'],
    ['a leading dash', '-eth'],
    ['128 arbitrary bytes', 'x'.repeat(128)],
    ['an empty value', ''],
  ])('rejects %s', (_name, value) => {
    expect(() => parseNetworkSelector(value)).toThrow('network must be one lowercase slug');
  });

  it.each([undefined, null, 42, ['ethereum', 'solana'], { a: 'b' }])(
    'rejects the non-string %p',
    (value) => {
      expect(() => parseNetworkSelector(value)).toThrow('network must be one lowercase slug');
    },
  );

  it.each(['ethereum', 'solana', 'base-sepolia', 'eth2'])('accepts %p', (value) => {
    expect(parseNetworkSelector(value)).toBe(value);
  });
});

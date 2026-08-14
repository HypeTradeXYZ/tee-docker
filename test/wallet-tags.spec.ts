import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newMnemonic, Wallet, Workspace } from 'wative-core';
import type { ServiceState } from '../src/config/schemas';
import type { ServiceStateService } from '../src/config/service-state.service';
import type { Session } from '../src/session/session.registry';
import { normalizeWalletTags, WalletTagsService } from '../src/session/wallet-tags.service';

function fixture(initialTags = ['old-a', 'old-b'], workspaceSlug = 'desk-a') {
  const data: ServiceState = {
    tenants: {
      acme: {
        walletTotal: 1,
        workspaces: [{ slug: workspaceSlug, createdAt: new Date(0).toISOString(), walletCount: 1 }],
      },
    },
  };
  const state = {
    tenant: jest.fn((tenantId: string) => data.tenants[tenantId]),
    mutate: jest.fn(async (fn: (draft: ServiceState) => unknown) => fn(data)),
  } as unknown as ServiceStateService;
  let tags = [...initialTags];
  const account = {
    slug: 'account-a',
    _persist: jest.fn(async () => undefined),
  };
  const wallet = {
    id: 3,
    _account: account,
    get tags() { return [...tags]; },
    clearTags: jest.fn(async () => { tags = []; }),
    addTag: jest.fn(async (tag: string) => { if (!tags.includes(tag)) tags.push(tag); }),
  } as unknown as Wallet;
  const session = {
    tenantId: 'acme',
    workspaceSlug,
    unusable: false,
    handle: {
      accounts: {
        bySlug: () => ({ wallets: { byId: () => wallet } }),
      },
    },
  } as unknown as Session;
  return {
    data,
    state,
    account,
    wallet,
    session,
    service: new WalletTagsService(state),
    tags: () => tags,
    setTags: (next: string[]) => { tags = [...next]; },
  };
}

describe('durable wallet tag replacement', () => {
  it('uses core normalization before journaling and installs one complete target', async () => {
    const f = fixture();
    await f.service.replace(f.session, f.wallet, ['  first  ', 'e\u0301', 'é']);

    expect(f.tags()).toEqual(['first', 'é']);
    expect(f.account._persist).toHaveBeenCalledTimes(1);
    expect(f.data.tenants.acme.walletTagRecoveries).toBeUndefined();
    expect(f.state.mutate).toHaveBeenCalledTimes(2);
  });

  it('does no durable work when the normalized target is unchanged', async () => {
    const f = fixture(['first', 'é']);
    await f.service.replace(f.session, f.wallet, [' first ', 'e\u0301']);
    expect(f.state.mutate).not.toHaveBeenCalled();
    expect(f.wallet.clearTags).not.toHaveBeenCalled();
  });

  it('treats constructor as an own workspace-recovery key', async () => {
    const f = fixture(['old'], 'constructor');
    f.data.tenants.acme.walletTagRecoveries = {};

    await expect(f.service.recoverWorkspace(f.session)).resolves.toBeUndefined();
    expect(f.wallet.clearTags).not.toHaveBeenCalled();

    await f.service.replace(f.session, f.wallet, ['new']);
    expect(f.tags()).toEqual(['new']);
    expect(f.data.tenants.acme.walletTagRecoveries).toBeUndefined();
    expect(f.state.mutate).toHaveBeenCalledTimes(2);
  });

  it('restores the exact old set and preserves the forward error after a middle write fails', async () => {
    const f = fixture();
    const forward = new Error('forward add failed');
    jest.mocked(f.wallet.addTag)
      .mockImplementationOnce(async (tag: string) => { f.setTags([tag]); })
      .mockRejectedValueOnce(forward)
      .mockImplementation(async (tag: string) => { f.setTags([...f.tags(), tag]); });

    await expect(f.service.replace(f.session, f.wallet, ['new-a', 'new-b', 'new-c']))
      .rejects.toBe(forward);
    expect(f.tags()).toEqual(['old-a', 'old-b']);
    expect(f.account._persist).toHaveBeenCalledTimes(1);
    expect(f.data.tenants.acme.walletTagRecoveries).toBeUndefined();
    expect(f.session.unusable).toBe(false);
  });

  it('retires the session and retains recovery when rollback cannot complete', async () => {
    const f = fixture();
    const forward = new Error('forward add failed');
    const rollback = new Error('rollback clear failed');
    jest.mocked(f.wallet.addTag).mockRejectedValueOnce(forward);
    jest.mocked(f.wallet.clearTags)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollback);

    const result = f.service.replace(f.session, f.wallet, ['new-a']);
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [forward, rollback] });
    expect(f.session.unusable).toBe(true);
    expect(f.data.tenants.acme.walletTagRecoveries?.['desk-a']?.oldTags)
      .toEqual(['old-a', 'old-b']);
  });

  it('retires the session when final rollback confirmation fails', async () => {
    const f = fixture();
    const forward = new Error('forward add failed');
    const rollback = new Error('rollback confirmation failed');
    jest.mocked(f.wallet.addTag)
      .mockRejectedValueOnce(forward)
      .mockImplementation(async (tag: string) => { f.setTags([...f.tags(), tag]); });
    f.account._persist.mockRejectedValueOnce(rollback);

    await expect(f.service.replace(f.session, f.wallet, ['new-a']))
      .rejects.toMatchObject({ errors: [forward, rollback] });
    expect(f.session.unusable).toBe(true);
    expect(f.data.tenants.acme.walletTagRecoveries?.['desk-a']).toBeDefined();
  });

  it('does not roll back a confirmed target when journal deletion is indeterminate', async () => {
    const f = fixture();
    const finalization = new Error('journal delete committed then threw');
    jest.mocked(f.state.mutate)
      .mockImplementationOnce(async (fn: (draft: ServiceState) => unknown) => fn(f.data))
      .mockImplementationOnce(async (fn: (draft: ServiceState) => unknown) => {
        fn(f.data);
        throw finalization;
      });

    await expect(f.service.replace(f.session, f.wallet, ['new-a', 'new-b']))
      .rejects.toBe(finalization);
    expect(f.tags()).toEqual(['new-a', 'new-b']);
    expect(f.wallet.clearTags).toHaveBeenCalledTimes(1);
    expect(f.account._persist).toHaveBeenCalledTimes(1);
    expect(f.session.unusable).toBe(true);
  });

  it('does not repeat a confirmed rollback when journal deletion is indeterminate', async () => {
    const f = fixture();
    const forward = new Error('forward add failed');
    const finalization = new Error('journal delete ambiguous');
    jest.mocked(f.wallet.addTag)
      .mockRejectedValueOnce(forward)
      .mockImplementation(async (tag: string) => { f.setTags([...f.tags(), tag]); });
    jest.mocked(f.state.mutate)
      .mockImplementationOnce(async (fn: (draft: ServiceState) => unknown) => fn(f.data))
      .mockImplementationOnce(async (fn: (draft: ServiceState) => unknown) => {
        fn(f.data);
        throw finalization;
      });

    await expect(f.service.replace(f.session, f.wallet, ['new-a']))
      .rejects.toMatchObject({ errors: [forward, finalization] });
    expect(f.tags()).toEqual(['old-a', 'old-b']);
    expect(f.wallet.clearTags).toHaveBeenCalledTimes(2);
    expect(f.account._persist).toHaveBeenCalledTimes(1);
    expect(f.session.unusable).toBe(true);
  });

  it('replays an interrupted old-value snapshot before clearing the journal', async () => {
    const f = fixture(['partial-new']);
    f.data.tenants.acme.walletTagRecoveries = {
      'desk-a': { accountSlug: 'account-a', walletId: 3, oldTags: ['old-a', 'old-b'] },
    };

    await f.service.recoverWorkspace(f.session);
    expect(f.tags()).toEqual(['old-a', 'old-b']);
    expect(f.account._persist).toHaveBeenCalledTimes(1);
    expect(f.data.tenants.acme.walletTagRecoveries).toBeUndefined();
  });

  it('keeps recovery durable when replay fails', async () => {
    const f = fixture(['partial-new']);
    f.data.tenants.acme.walletTagRecoveries = {
      'desk-a': { accountSlug: 'account-a', walletId: 3, oldTags: ['old-a'] },
    };
    jest.mocked(f.wallet.clearTags).mockRejectedValueOnce(new Error('replay failed'));

    await expect(f.service.recoverWorkspace(f.session)).rejects.toThrow('replay failed');
    expect(f.data.tenants.acme.walletTagRecoveries?.['desk-a']).toBeDefined();
  });

  it('restores an interrupted real 2.4.4 account before a reopened handle is usable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wallet-tag-recovery-'));
    const password = 'Workspace-Passw0rd!x';
    try {
      let workspace = await Workspace.open({ path: root, password });
      const account = await workspace.accounts.create(
        'tag recovery',
        password,
        newMnemonic(),
        undefined,
        { kind: 'HD', hasOwnPassword: false },
      );
      const wallet = account.wallets[0];
      await wallet.addTag('old-a');
      await wallet.addTag('old-b');
      const accountSlug = String(account.slug);
      await wallet.clearTags();
      await wallet.addTag('partial-new');
      await workspace.lock();

      const data: ServiceState = {
        tenants: {
          acme: {
            walletTotal: 1,
            workspaces: [
              { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 1 },
            ],
            walletTagRecoveries: {
              'desk-a': { accountSlug, walletId: 0, oldTags: ['old-a', 'old-b'] },
            },
          },
        },
      };
      const state = {
        tenant: () => data.tenants.acme,
        mutate: async (fn: (draft: ServiceState) => unknown) => fn(data),
      } as unknown as ServiceStateService;
      workspace = await Workspace.open({ path: root, password });
      const session = {
        tenantId: 'acme', workspaceSlug: 'desk-a', handle: workspace, unusable: false,
      } as unknown as Session;

      await new WalletTagsService(state).recoverWorkspace(session);
      expect(workspace.accounts.bySlug(accountSlug as never)?.wallets[0].tags)
        .toEqual(['old-a', 'old-b']);
      await workspace.lock();

      workspace = await Workspace.open({ path: root, password });
      expect(workspace.accounts.bySlug(accountSlug as never)?.wallets[0].tags)
        .toEqual(['old-a', 'old-b']);
      expect(data.tenants.acme.walletTagRecoveries).toBeUndefined();
      await workspace.lock();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('wallet tag validation compatibility', () => {
  it('uses the pinned core rules without touching a real account', async () => {
    await expect(normalizeWalletTags(['  alpha  ', 'e\u0301', 'é']))
      .resolves.toEqual(['alpha', 'é']);
    await expect(normalizeWalletTags(['java\u200bscript:alert']))
      .rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
    await expect(normalizeWalletTags(['a'.repeat(65)]))
      .rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
  });
});

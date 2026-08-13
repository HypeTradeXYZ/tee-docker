import { TeeError } from '../src/common/tee-error';
import { BalancesController } from '../src/session/balances.controller';
import type { Session, SessionRegistry } from '../src/session/session.registry';

function fixture(found: object | null, accounts: readonly object[]) {
  const requireAccount = jest.fn(async () => undefined);
  const session = {
    handle: {
      filter: jest.fn(() => found),
      accounts,
    },
  } as unknown as Session;
  const controller = new BalancesController({ requireAccount } as unknown as SessionRegistry);
  return { controller, requireAccount, session };
}

describe('dormant balance owner gate', () => {
  it('rejects an unknown address before custody access', async () => {
    const f = fixture(null, []);
    await expect(f.controller.balances(f.session, 'unknown')).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_NOT_FOUND',
    });
    expect(f.requireAccount).not.toHaveBeenCalled();
  });

  it('rejects an orphaned address before custody access', async () => {
    const address = { publicKey: 'pk-orphan' };
    const f = fixture(address, []);
    await expect(f.controller.balances(f.session, address.publicKey)).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_NOT_FOUND',
    });
    expect(f.requireAccount).not.toHaveBeenCalled();
  });

  it('propagates an owning-account custody denial before balance work', async () => {
    const address = { publicKey: 'pk-owned' };
    const account = { slug: 'vault', wallets: [{ addresses: [address] }] };
    const f = fixture(address, [account]);
    f.requireAccount.mockRejectedValueOnce(
      new TeeError('TEE_ACCOUNT_LOCKED', 'account requires explicit unlock'),
    );
    await expect(f.controller.balances(f.session, address.publicKey)).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_LOCKED',
    });
    expect(f.requireAccount).toHaveBeenCalledWith(f.session, 'vault');
  });

  it('still terminates at the stable capability error after successful custody', async () => {
    const address = { publicKey: 'pk-owned' };
    const account = { slug: 'shared', wallets: [{ addresses: [address] }] };
    const f = fixture(address, [account]);
    await expect(f.controller.balances(f.session, address.publicKey)).rejects.toMatchObject({
      code: 'TEE_BALANCES_UNAVAILABLE',
    });
    expect(f.requireAccount).toHaveBeenCalledWith(f.session, 'shared');
  });
});

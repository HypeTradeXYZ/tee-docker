import {
  AUDITED_BALANCE_CORE_VERSION,
  BalanceCapabilityGuard,
  INSTALLED_BALANCE_CORE_VERSION,
  balanceCapabilityAvailable,
} from '../src/session/balance-capability';
import { BalancesController } from '../src/session/balances.controller';

describe('balance capability gate', () => {
  it('trips whenever the installed dependency moves beyond the audited build', () => {
    expect(INSTALLED_BALANCE_CORE_VERSION).toBe(AUDITED_BALANCE_CORE_VERSION);
    expect(AUDITED_BALANCE_CORE_VERSION).toBe('2.4.4');
  });

  it('keeps audited and unknown core versions fail closed', () => {
    expect(balanceCapabilityAvailable('2.4.4')).toBe(false);
    expect(balanceCapabilityAvailable('2.4.5')).toBe(false);
    expect(balanceCapabilityAvailable(undefined)).toBe(false);
  });

  it('returns a stable tee-owned capability error', () => {
    expect(() => new BalanceCapabilityGuard().canActivate()).toThrow(
      expect.objectContaining({
        code: 'TEE_BALANCES_UNAVAILABLE',
        message: 'Balance lookup is not available in this release.',
      }),
    );
  });

  it('skips disabled idle touch while retaining future RPC accounting', () => {
    expect(Reflect.getMetadata('tee:skip-workspace-idle-touch', BalancesController.prototype.balances))
      .toBe(true);
    expect(Reflect.getMetadata('tee:skip-workspace-mutex', BalancesController.prototype.balances))
      .toBeUndefined();
    // Guards run before interceptors, so the disabled route consumes neither
    // mutex nor permit. If enabled after review, H-06 is already mandatory.
    expect(Reflect.getMetadata('tee:rpc-operation', BalancesController.prototype.balances))
      .toBe(true);
  });
});

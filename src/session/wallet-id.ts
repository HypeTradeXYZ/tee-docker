import { teeCoreError } from '../common/tee-error';


const CANONICAL_WALLET_ID = /^(0|[1-9]\d*)$/;

/** Parse a canonical nonnegative safe-integer wallet path id without aliases. */
export function parseWalletId(value: string): number {
  const parsed = CANONICAL_WALLET_ID.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw teeCoreError('PARAMETER_ERROR', 'wallet id must be a canonical nonnegative integer');
  }
  return parsed;
}

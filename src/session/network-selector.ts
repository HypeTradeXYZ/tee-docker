import { WativeError } from 'wative-core';

/** Accept exactly one bounded, non-whitespace network selector without normalization. */
export function parseNetworkSelector(value: unknown): string {
  if (typeof value !== 'string' || !/^\S{1,128}$/u.test(value)) {
    throw new WativeError('PARAMETER_ERROR', 'network must be one nonempty query value');
  }
  return value;
}

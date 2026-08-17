import { Account, type Workspace } from 'wative-core';
import { teeCoreError } from '../common/tee-error';

const FIXED_ERROR = 'displayName must normalize to 4–64 characters and produce an account slug';

/**
 * Apply the pinned core's display-name sanitizer and bounds without touching
 * tenant storage, then enforce the creation-only nonempty slug projection.
 */
export async function normalizeAccountDisplayName(value: string): Promise<string> {
  const validator = new Account({
    workspace: {} as Workspace,
    data: {
      slug: 'display-name-validator' as never,
      displayName: 'validator',
      organizationType: 'HD',
      encryptionAlgorithm: 'validator',
      signature: 'validator',
      hasOwnPassword: false,
      defaultNetworkSlug: 'ethereum' as never,
      wallets: [],
    },
  });
  Object.defineProperty(validator, '_persistInternal', {
    configurable: true,
    value: async () => undefined,
  });

  try {
    await validator.setDisplayName(value);
    const normalized = validator.displayName;
    const slugProjection = normalized.normalize('NFKD').replace(/\p{M}/gu, '');
    if (!/[A-Za-z]/.test(slugProjection)) throw new Error('empty account slug projection');
    return normalized;
  } catch {
    // Core validation messages can contain the rejected input. The API uses a
    // fixed reviewed error while retaining core's public code and status.
    throw teeCoreError('PARAMETER_ERROR', FIXED_ERROR);
  }
}

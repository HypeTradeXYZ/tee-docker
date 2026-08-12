import type { WativeErrorCode } from 'wative-core';

/**
 * Reviewed against wative-core 2.4.4. `satisfies` rejects invented codes and
 * the exhaustiveness assertion below makes typecheck fail when core adds one.
 */
export const WATIVE_ERROR_CODES = [
  'WORKSPACE_LOCKED',
  'ACCOUNT_LOCKED',
  'RECORD_LOCKED',
  'BAD_PASSWORD',
  'WEAK_PASSWORD',
  'RECORD_NOT_FOUND',
  'PROVIDER_IO',
  'PERMISSION_DENIED',
  'DISK_FULL',
  'PARAMETER_ERROR',
  'DECRYPT_FAILED',
  'ENCRYPT_FAILED',
  'ALGORITHM_IRREVERSIBLE',
  'INVALID_MNEMONIC',
  'INVALID_PRIVATE_KEY',
  'UNSUPPORTED_NETWORK',
  'TX_BUILD_FAILED',
  'TX_SIGN_FAILED',
  'TX_SUBMIT_FAILED',
  'TX_TIMEOUT',
  'TX_DROPPED',
  'TX_ABORTED',
  'RPC_UNREACHABLE',
  'RPC_REJECTED',
  'STORAGE_NOT_DURABLE',
  'UNSUPPORTED_OP',
] as const satisfies readonly WativeErrorCode[];

type MissingCoreCode = Exclude<WativeErrorCode, (typeof WATIVE_ERROR_CODES)[number]>;
const WATIVE_ERROR_CATALOG_IS_EXHAUSTIVE: MissingCoreCode extends never ? true : never = true;
void WATIVE_ERROR_CATALOG_IS_EXHAUSTIVE;

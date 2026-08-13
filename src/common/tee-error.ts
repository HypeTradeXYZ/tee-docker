/**
 * tee-docker's own error codes. Deliberately namespaced `TEE_` so they share
 * one lookup table with wative-core's codes without any chance of collision.
 *
 * Every code here MUST have an entry in config/errors.json. The filter degrades
 * gracefully on a miss, but a miss is still a bug — `errors.spec.ts` asserts
 * full coverage so a new code cannot ship unmapped.
 */
export const TEE_ERROR_CODES = [
  'TEE_BAD_API_KEY',
  'TEE_SESSION_EXPIRED',
  'TEE_QUOTA_WORKSPACES',
  'TEE_QUOTA_WALLETS',
  'TEE_EXPORT_DISABLED',
  'TEE_RPC_NOT_CONFIGURED',
  'TEE_UNLOCK_CAPACITY',
  'TEE_WORKSPACE_EXISTS',
  'TEE_WORKSPACE_NOT_FOUND',
  'TEE_WORKSPACE_IN_USE',
  'TEE_INVALID_SLUG',
  'TEE_KDF_BACKEND_UNSAFE',
  'TEE_ACCOUNT_LOCKED',
  'TEE_ACCOUNT_NOT_FOUND',
  'TEE_SCOPE_DENIED',
  'TEE_SESSION_CAPACITY',
  'TEE_RPC_UNSAFE',
  'TEE_RPC_UNREACHABLE',
  'TEE_ACCOUNT_UNLOCK_RATE',
  'TEE_RPC_CAPACITY',
  'TEE_BALANCES_UNAVAILABLE',
  'TEE_WORKSPACE_CREATE_RATE',
  'TEE_WORKSPACE_RECREATE_COOLDOWN',
] as const;

export type TeeErrorCode = (typeof TEE_ERROR_CODES)[number];

export class TeeError extends Error {
  readonly code: TeeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: TeeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TeeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

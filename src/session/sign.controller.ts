import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Address } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { CurrentSession, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { SessionRegistry, type Session } from './session.registry';

const SignMessage = z.object({
  address: z.string().min(1).max(128),
  message: z.string(),
  encoding: z.enum(['personal_sign', 'raw', 'ed25519']).optional(),
});

const SignTypedData = z.object({
  address: z.string().min(1).max(128),
  typedData: z.unknown(),
  chainId: z.number().int().positive().optional(),
});

/**
 * Signing.
 *
 * Addresses are resolved inside the workspace by public key, so callers do not
 * have to walk account -> wallet -> address. Resolution is scoped to the
 * session's own workspace, so one tenant can never sign with another's key.
 */
@Controller('sign')
@UseGuards(WorkspaceGuard, ScopesGuard)
@RequireScopes('sign')
export class SignController {
  constructor(private readonly sessions: SessionRegistry) {}

  @Post('message')
  @HttpCode(200)
  async message(
    @CurrentSession() session: Session,
    @Body() body: unknown,
  ): Promise<{ address: string; signature: string; messageHash?: string }> {
    const parsed = SignMessage.safeParse(body);
    if (!parsed.success) {
      throw new TeeError('TEE_INVALID_BODY', 'body must be { address, message, encoding? }');
    }

    const address = await this.resolve(session, parsed.data.address);

    if (parsed.data.encoding) {
      const out = address.signMessageEncoded(parsed.data.message, parsed.data.encoding);
      return { address: String(address.publicKey), ...out };
    }
    return {
      address: String(address.publicKey),
      signature: address.signMessage(parsed.data.message),
    };
  }

  @Post('typed-data')
  @HttpCode(200)
  async typedData(
    @CurrentSession() session: Session,
    @Body() body: unknown,
  ): Promise<{ address: string; signature: string; domainSeparator: string; structHash: string }> {
    const parsed = SignTypedData.safeParse(body);
    if (!parsed.success) {
      throw new TeeError('TEE_INVALID_BODY', 'body must be { address, typedData, chainId? }');
    }

    const address = await this.resolve(session, parsed.data.address);
    if (address.vm !== 'evm') {
      throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'typed-data signing is EVM only');
    }

    // Falls back to the address's own network rather than defaulting to a
    // chain the caller never named — a signed transaction is a bearer
    // instrument, and 2.4.1 removed the silent mainnet default for exactly
    // this reason.
    const chainId = parsed.data.chainId ?? Number(address.network.chainId);
    const out = address.signTypedData(parsed.data.typedData, chainId);
    return { address: String(address.publicKey), ...out };
  }

  /**
   * Find an address by public key within this session's workspace, unlocking
   * its account lazily. `filter` searches the whole workspace, so the owning
   * account is resolved from the hit and then unlocked through the registry —
   * that keeps own-password accounts behind their 423.
   */
  private async resolve(session: Session, publicKey: string): Promise<Address> {
    const found = session.handle.filter(publicKey, 'Address');
    if (!found) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" not found`);
    }

    const owner = session.handle.accounts.find((a) =>
      a.wallets.some((w) => w.addresses.some((addr) => addr.publicKey === found.publicKey)),
    );
    if (!owner) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" has no account`);
    }

    await this.sessions.requireAccount(session, String(owner.slug));
    return found;
  }
}

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

/** One EIP-712 struct field. Loose: core accepts a field carrying extra keys. */
const Eip712Field = z.looseObject({ name: z.string().min(1), type: z.string().min(1) });

/**
 * The eth_signTypedData_v4 envelope, pinned only where core already refuses the
 * same payload. Every shape rejected here is one core rejects too, measured
 * against 2.4.4 — this names those 400s, it does not add any.
 *
 * `domain` is checked for presence but never for shape: core deliberately signs
 * a domain given as an array, a number or a boolean, because every other
 * implementation signs them identically and refusing them would break callers.
 */
const Eip712Payload = z.looseObject({
  domain: z.unknown(),
  types: z.record(z.string(), z.array(Eip712Field)),
  primaryType: z.string().min(1),
  message: z.looseObject({}),
});

/**
 * The chain a typed-data domain names, in the three forms core normalizes
 * identically: a number, a decimal string, or a hex string.
 *
 * Returns undefined for everything else — including a domain that is not a
 * plain object, which core still signs. An unreadable chain id is left to core
 * rather than guessed at, so this can only ever refuse a genuine disagreement.
 */
function declaredChainId(domain: unknown): number | undefined {
  if (domain === null || typeof domain !== 'object' || Array.isArray(domain)) return undefined;
  const value: unknown = (domain as Record<string, unknown>).chainId;

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const text = value.trim();
  // Wide enough for a 256-bit chain id, which parses as unsafe and is ignored.
  if (text.length === 0 || text.length > 66) return undefined;
  const parsed = /^0[xX][0-9a-fA-F]+$/.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : /^[0-9]+$/.test(text)
      ? Number.parseInt(text, 10)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

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

    const payload = Eip712Payload.safeParse(parsed.data.typedData);
    if (!payload.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        'typedData must be an EIP-712 object with domain, types, primaryType and message',
      );
    }

    // The struct being signed has to exist. Matching is exact and
    // case-sensitive, and the name is never echoed back: it is caller-supplied
    // and bounded only by the envelope.
    if (!Object.prototype.hasOwnProperty.call(payload.data.types, payload.data.primaryType)) {
      throw new TeeError('TEE_INVALID_BODY', 'primaryType must name one of the structs in types');
    }

    // Falls back to the address's own network rather than defaulting to a
    // chain the caller never named — a signed transaction is a bearer
    // instrument, and 2.4.1 removed the silent mainnet default for exactly
    // this reason.
    const chainId = parsed.data.chainId ?? Number(address.network.chainId);

    // A domain that names a different chain than the one being signed for is a
    // contradiction in the request, and core refuses it with the same opaque
    // 400 it uses for every other malformed payload. Say which two disagree.
    const declared = declaredChainId(payload.data.domain);
    if (declared !== undefined && Number.isSafeInteger(chainId) && declared !== chainId) {
      throw new TeeError(
        'TEE_CHAIN_ID_MISMATCH',
        `typedData.domain.chainId ${declared} does not match the signing chain ${chainId}`,
      );
    }

    // Core is handed the caller's own object, never the parsed copy: validation
    // here is a gate, and a normalized value would change the signed bytes.
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

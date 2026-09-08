import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';
import { invalidBodyMessage } from '../common/invalid-body';
import type { Tenant } from '../config/schemas';
import { SessionRegistry } from '../session/session.registry';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { assertValidAccountSlug } from '../session/account-slug';
import { MintRateLimiter } from './mint-rate-limit';
import { CurrentTenant, TenantGuard } from './tenant.guard';
import { ApiKeyService, type ApiKeyResult } from './api-key.service';

const MintBody = z
  .object({
    workspace: z.string(),
    password: z.string().min(1),
    account: z.string(),
    // When present, the token is scoped to this one wallet; otherwise to the account.
    walletId: z.number().int().nonnegative().safe().optional(),
    // Optional inquiry key (`x25519:<base64>`) that unlocks the sensitive functions.
    inquiryKey: z.string().min(1).max(128).optional(),
    // Inquiry-key validity in seconds (tenant-set); defaults to 4h. Bounded to
    // keep now+duration a safe integer.
    validationDuration: z
      .number()
      .int()
      .positive()
      .max(365 * 24 * 3600)
      .optional(),
  })
  .strict();

/**
 * The tenant tier mints a scoped API key for an end user, bound to one account
 * or one wallet. Authenticated by the tenant, because minting is where the
 * workspace password is presented.
 */
@Controller('auth')
export class ApiKeyController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly sessions: SessionRegistry,
    private readonly rateLimit: MintRateLimiter,
  ) {}

  @Post('api-key')
  @HttpCode(201)
  @UseGuards(TenantGuard)
  async mint(
    @CurrentTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiKeyResult> {
    // This response carries a bearer token — keep it out of every cache.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');

    const parsed = MintBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage(
          'body must be { workspace, password, account, walletId? }',
          parsed.error,
          body,
        ),
      );
    }
    const workspace = assertValidSlug(parsed.data.workspace);
    const account = assertValidAccountSlug(parsed.data.account);
    if (!this.sessions.knowsWorkspace(tenant.id, workspace)) {
      throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspace}" not found`);
    }
    this.rateLimit.check(tenant.id);
    return this.apiKeys.mint(tenant, {
      workspace,
      password: parsed.data.password,
      account,
      ...(parsed.data.walletId !== undefined ? { walletId: parsed.data.walletId } : {}),
      ...(parsed.data.inquiryKey !== undefined ? { inquiryKey: parsed.data.inquiryKey } : {}),
      ...(parsed.data.validationDuration !== undefined
        ? { validationDuration: parsed.data.validationDuration }
        : {}),
    });
  }
}

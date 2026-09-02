import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { TeeError } from '../common/tee-error';
import { invalidBodyMessage } from '../common/invalid-body';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { AdminGuard } from './admin.guard';
import { AdminService, type LiftResult } from './admin.service';

// Bounded by the same rule LimitsSchema holds these fields to, so a value the
// endpoint accepts is always a value the operator config can hold.
const Limit = z.number().int().nonnegative();

const LiftBody = z
  .object({
    maxWorkspaces: Limit.optional(),
    maxWallets: Limit.optional(),
  })
  .strict()
  .refine(
    (body) => body.maxWorkspaces !== undefined || body.maxWallets !== undefined,
    'at least one of maxWorkspaces or maxWallets is required',
  );

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('tenants/:id/limits')
  async liftLimits(@Param('id') id: string, @Body() body: unknown): Promise<LiftResult> {
    const parsed = LiftBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage(
          'body must be { maxWorkspaces?, maxWallets? } with at least one field',
          parsed.error,
          body,
        ),
      );
    }
    // A tenant id is a directory name, held to the same grammar everywhere.
    return this.admin.liftLimits(assertValidSlug(id), parsed.data);
  }
}

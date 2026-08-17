import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { TeeError, teeCoreError } from '../common/tee-error';
import type { Tenant, WorkspaceState } from '../config/schemas';
import { CurrentTenant, TenantGuard } from '../auth/tenant.guard';
import { WorkspacesService } from './workspaces.service';
import { assertValidSlug } from './workspace-paths';

const CreateBody = z.object({
  slug: z.string(),
  password: z.string().min(1),
});

@Controller()
@UseGuards(TenantGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('workspaces')
  list(@CurrentTenant() tenant: Tenant): { workspaces: readonly WorkspaceState[] } {
    return { workspaces: this.workspaces.list(tenant) };
  }

  @Get('quota')
  quota(@CurrentTenant() tenant: Tenant) {
    return this.workspaces.quota(tenant);
  }

  @Post('workspaces')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: Tenant,
    @Body() body: unknown,
  ): Promise<{ workspace: WorkspaceState }> {
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError('TEE_INVALID_BODY', 'body must be { slug, password }');
    }
    const slug = assertValidSlug(parsed.data.slug);
    const workspace = await this.workspaces.create(tenant, slug, parsed.data.password);
    return { workspace };
  }

  @Delete('workspaces/:slug')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Query('force') force: unknown,
  ): Promise<void> {
    await this.workspaces.remove(tenant, assertValidSlug(slug), parseForce(force));
  }
}

function parseForce(value: unknown): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw teeCoreError('PARAMETER_ERROR', 'force must be exactly true or false');
}

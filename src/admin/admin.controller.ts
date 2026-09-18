import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { TeeError } from '../common/tee-error';
import { invalidBodyMessage } from '../common/invalid-body';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { AdminGuard } from './admin.guard';
import { AdminService, type LiftResult } from './admin.service';
import { DiagnosticsService, type DiagnosticsSnapshot } from './diagnostics.service';
import {
  ACTIVITY_KINDS,
  ActivityLog,
  type ActivityEvent,
  type PerfSample,
} from '../observability/activity-log.service';

// Bounds mirror the buffer's own clamps; an out-of-range value is a bad query,
// not a silent truncation.
const ActivityQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(50_000).optional(),
    sinceSeq: z.coerce.number().int().nonnegative().optional(),
    kind: z.enum(ACTIVITY_KINDS).optional(),
  })
  .strict();

const MetricsQuery = z
  .object({ limit: z.coerce.number().int().positive().max(20_000).optional() })
  .strict();

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
  constructor(
    private readonly admin: AdminService,
    private readonly diagnostics: DiagnosticsService,
    private readonly activity: ActivityLog,
  ) {}

  // Read-only operational snapshot for remote diagnosis (FD/memory/session/RPC
  // gauges). Behind the same X-Admin-Key as the limits route — these internals
  // are profiling information and never belong on the public health probe.
  @Get('diagnostics')
  getDiagnostics(): DiagnosticsSnapshot {
    return this.diagnostics.snapshot();
  }

  // The recent-activity ring, pulled incrementally: pass the previous response's
  // lastSeq back as sinceSeq for a gap-free tail. Same admin tier as the gauges.
  @Get('activity')
  getActivity(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): { events: ActivityEvent[]; lastSeq: number } {
    const parsed = ActivityQuery.safeParse(query ?? {});
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('query must be { limit?, sinceSeq?, kind? }', parsed.error, query),
      );
    }
    noStore(res);
    const events = this.activity.recent(parsed.data);
    return { events, lastSeq: this.activity.stats().lastSeq };
  }

  // The perf-sample time-series (event-loop lag, memory, fds), for spotting the
  // stalls the cumulative diagnostics histogram cannot place in time.
  @Get('metrics')
  getMetrics(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): { samples: PerfSample[] } {
    const parsed = MetricsQuery.safeParse(query ?? {});
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('query must be { limit? }', parsed.error, query),
      );
    }
    noStore(res);
    return { samples: this.activity.perfSamples(parsed.data.limit) };
  }

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

/** Diagnostic snapshots are point-in-time; never let a proxy or client cache one. */
function noStore(res: Response): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
}

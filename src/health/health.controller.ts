import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ShutdownState } from './shutdown.state';

@Controller('health')
export class HealthController {
  constructor(private readonly lifecycle: ShutdownState) {}

  /**
   * Liveness only. Deliberately says nothing about tenants, workspaces, or
   * session counts — this endpoint is typically the one left unauthenticated.
   *
   * Once graceful shutdown has begun it answers 503, so a liveness probe cycles
   * a process whose drain has hung rather than leaving it healthy but unable to
   * unlock a workspace. Only the probe's verdict changes; nothing else is read.
   */
  @Get()
  check(@Res({ passthrough: true }) res: Response): { status: 'ok' | 'shutting_down' } {
    if (this.lifecycle.isShuttingDown()) {
      res.status(503);
      return { status: 'shutting_down' };
    }
    return { status: 'ok' };
  }
}

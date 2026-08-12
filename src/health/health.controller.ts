import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /**
   * Liveness only. Deliberately says nothing about tenants, workspaces, or
   * session counts — this endpoint is typically the one left unauthenticated.
   */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';

/**
 * Tracks whether graceful shutdown has begun. Flipped in beforeApplicationShutdown
 * so it leads the session registry's own gate — the health probe then reports the
 * shutdown before the first mint starts failing, instead of staying 200 forever.
 */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  #shuttingDown = false;

  beforeApplicationShutdown(): void {
    this.#shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.#shuttingDown;
  }
}

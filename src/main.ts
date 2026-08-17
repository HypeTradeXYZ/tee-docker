import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadEnvFiles } from './config/env';
import { installRequestIdMiddleware } from './common/request-id.middleware';
import { takeHeldServiceState } from './config/config.module';
import { SessionRegistry } from './session/session.registry';

// Held so a failed boot can still release the ledger's process lock: without
// it the next start fails closed on a lock this process left behind.
let booted: INestApplication | undefined;

async function bootstrap(): Promise<void> {
  // Static imports have already evaluated AppModule, so configuration must
  // stay lazy: load env files before Nest constructs any config providers.
  const loaded = loadEnvFiles();

  // abortOnError:false so a provider failure REJECTS this promise instead of
  // Nest exiting from inside create() — otherwise the deliberate message the
  // config loaders were written to produce never reaches the catch below.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  booted = app;
  installFatalHandlers(app);
  installRequestIdMiddleware(app);
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  // Port and env-file names only — no filesystem locations in startup output.
  const log = new Logger('bootstrap');
  log.log(`env files loaded: ${loaded.files.length ? loaded.files.join(', ') : 'none'}`);
  log.log(`tee-docker listening on :${port}`);
}

/**
 * A fatal error must not take decrypted key material to the grave unlocked.
 *
 * Nest's shutdown hooks do not run on an unhandled rejection or an uncaught
 * exception, so lock explicitly here. The registry's best-effort primitive
 * never throws and is bounded, because throwing inside an exception handler
 * would replace the diagnosis with a second, less useful failure.
 */
function installFatalHandlers(app: INestApplication): void {
  const log = new Logger('fatal');
  let exiting = false;

  const die = (event: string, reason: unknown): void => {
    if (exiting) return;
    exiting = true;
    // Installing a handler stops Node terminating by itself, so anything that
    // throws in here would leave the process alive forever. Every step is
    // guarded and a watchdog guarantees the exit.
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      log.error(`${event}: ${describeFatal(reason)}`);
      void app
        .get(SessionRegistry)
        .lockAllHandlesBestEffort()
        .then((failures) => {
          for (const failure of failures) log.error(`lock failed: ${describeFatal(failure)}`);
        })
        .catch(() => undefined)
        .finally(() => {
          Logger.flush();
          process.exit(1);
        });
    } catch {
      Logger.flush();
      process.exit(1);
    }
  };

  process.on('unhandledRejection', (reason) => die('unhandledRejection', reason));
  process.on('uncaughtException', (error) => die('uncaughtException', error));
}

/** Total, and never a full stack: this string is logged during a crash. */
function describeFatal(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return typeof value === 'string' ? value : Object.prototype.toString.call(value);
  } catch {
    return 'unprintable value';
  }
}

bootstrap().catch(async (err: unknown) => {
  // A boot failure is deliberate and already described; surfacing it as an
  // unhandled rejection would bury that message under a stack trace.
  new Logger('bootstrap').fatal(describeFatal(err));
  // A half-started process may already hold the ledger lock. Releasing it is
  // what makes the next start possible; there is no owner left to hold it for.
  //
  // `booted` is only set AFTER NestFactory.create resolves, but the lock is
  // taken by ConfigModule's factory DURING it — so every ordinary boot failure
  // (a short HMAC key, an invalid limit, an unreadable tenants.json) lands here
  // with `booted` undefined. Fall back to the state service this process
  // published, or the lock survives a config typo and blocks the next start.
  try {
    if (booted) await booted.close();
    else await takeHeldServiceState()?.close();
  } catch {
    // Already reported; the exit below is what matters.
  }
  // bufferLogs holds everything until a successful listen, so without this an
  // operator gets exit code 1 and no output at all.
  Logger.flush();
  process.exit(1);
});

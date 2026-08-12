import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnvFiles } from './config/env';
import { installRequestIdMiddleware } from './common/request-id.middleware';

async function bootstrap(): Promise<void> {
  // Static imports have already evaluated AppModule, so configuration must
  // stay lazy: load env files before Nest constructs any config providers.
  const loaded = loadEnvFiles();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
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

void bootstrap();

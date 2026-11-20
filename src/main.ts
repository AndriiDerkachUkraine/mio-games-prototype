import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // rawBody: webhook signatures are verified over the exact bytes the casino sent.
  const app = await NestFactory.create(AppModule.forRoot(config), { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start', err);
  process.exit(1);
});

import { randomUUID } from 'node:crypto';
import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { AppConfig } from './config';
import { ConfigModule } from './config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';

// Caller-supplied ids are echoed into logs, so only accept a conservative shape.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            // Correlation id: reuse the caller's X-Request-Id so one id spans casino → MIO → casino.
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            redact: ['req.headers.authorization', 'req.headers["x-admin-key"]'],
          },
        }),
        DbModule,
      ],
      controllers: [HealthController],
    };
  }
}

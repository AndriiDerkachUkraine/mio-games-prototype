import { randomUUID } from 'node:crypto';
import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ApiExceptionFilter } from './common/api-exception.filter';
import type { AppConfig } from './config';
import { ConfigModule } from './config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { AdminModule } from './modules/admin/admin.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { RedemptionModule } from './modules/redemption/redemption.module';
import { StoreModule } from './modules/store/store.module';
import { WheelModule } from './modules/wheel/wheel.module';

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
            // Correlation id: reuse the caller's X-Request-Id when it is well-formed.
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            // Rejected requests (e.g. forged webhooks) must stand out from normal traffic.
            customLogLevel: (_req, res, err) =>
              err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
            redact: ['req.headers.authorization', 'req.headers["x-admin-key"]'],
          },
        }),
        DbModule,
        IngestionModule,
        WheelModule,
        LedgerModule,
        StoreModule,
        RedemptionModule,
        AdminModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}

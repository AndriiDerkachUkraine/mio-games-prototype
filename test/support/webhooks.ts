import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEV_TENANTS } from '../../src/db/seed';
import { signPlatformA } from '../../src/modules/integrations/platform-a/platform-a.platform';
import { signPlatformB } from '../../src/modules/integrations/platform-b/platform-b.platform';

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function platformADeposit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'a-evt-1',
    event_type: 'deposit',
    player_id: 'player-1',
    amount_cents: 5000,
    currency: 'EUR',
    status: 'SUCCESS',
    ...overrides,
  };
}

export function platformBDeposit(
  overrides: { notificationId?: string; timestamp?: number; data?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const { data, ...rest } = overrides;
  return {
    notificationId: 'b-ntf-1',
    timestamp: nowSeconds(),
    type: 'PAYMENT',
    ...rest,
    data: {
      operation: 'DEPOSIT',
      state: 2,
      amount: '50.00',
      currency: 'USD',
      customer: { ref: 'player-1' },
      ...data,
    },
  };
}

interface SendOptions {
  tenantId?: string;
  secret?: string;
  timestamp?: number;
  /** Sign this body but send `body`: simulates tampering in transit. */
  signedBody?: string;
  headers?: Record<string, string>;
  contentType?: string;
}

/** Signs like Casino A (Platform A) and posts to MIO. */
export function sendPlatformA(app: INestApplication, body: unknown, opts: SendOptions = {}): request.Test {
  const raw = JSON.stringify(body);
  const secret = opts.secret ?? DEV_TENANTS['casino-a'].webhookSecret;
  const headers = opts.headers ?? signPlatformA(opts.signedBody ?? raw, secret, opts.timestamp ?? nowSeconds());
  return post(app, opts.tenantId ?? 'casino-a', raw, headers, opts.contentType);
}

/** Signs like Casino B (Platform B) and posts to MIO. */
export function sendPlatformB(app: INestApplication, body: unknown, opts: SendOptions = {}): request.Test {
  const raw = JSON.stringify(body);
  const secret = opts.secret ?? DEV_TENANTS['casino-b'].webhookSecret;
  const headers = opts.headers ?? signPlatformB(opts.signedBody ?? raw, secret);
  return post(app, opts.tenantId ?? 'casino-b', raw, headers, opts.contentType);
}

function post(
  app: INestApplication,
  tenantId: string,
  raw: string,
  headers: Record<string, string>,
  contentType = 'application/json',
): request.Test {
  return request(app.getHttpServer())
    .post(`/v1/integrations/${tenantId}/events`)
    .set('content-type', contentType)
    .set(headers)
    .send(raw);
}
